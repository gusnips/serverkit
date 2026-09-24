/**
 * Signing a webhook you send, and checking one you receive, in the two formats the fleet uses.
 *
 * - **`signWebhook` / `verifyWebhook`**: one header, `t=<unix seconds>,v1=<hex>`, the format
 *   Stripe uses. The HMAC covers `<t>.<body>`, keyed by the whole secret, `whsec_` included:
 *   every receiver in the field hashes the whole string it was given.
 * - **`signStandardWebhook` / `verifyStandardWebhook`**: Standard Webhooks
 *   (standardwebhooks.com), which Supabase Auth's hooks use. Three headers, `webhook-id`,
 *   `webhook-timestamp` and `webhook-signature: v1,<base64>`, over `<id>.<timestamp>.<body>`,
 *   keyed by the base64 bytes after `whsec_`.
 *
 * Two pairs rather than one function with a format option: a fix to one must not change the
 * other. They share only the HMAC and the comparison.
 *
 * Both sign the TIMESTAMP with the body, and both refuse a timestamp more than five minutes from
 * the clock, so a captured delivery cannot be sent again later. Three verifiers in the fleet did
 * not check the age, and one of them is the recipe a product publishes to its customers.
 */
import { base64Of, bytesOfBase64, hmacSha256, safeEqual } from "./crypto.ts";

const DEFAULT_TOLERANCE_SECS = 300;
const SECRET_PREFIX = "whsec_";

export type WebhookRefusalReason =
  /** No secret was configured, so nothing can pass. A config problem, not an attack. */
  | "no-secret"
  | "missing-header"
  | "malformed"
  /** Signed more than `toleranceSecs` from now: a replay, or a clock that is off. */
  | "stale"
  | "bad-signature";

/**
 * `ok`, or why not. Answer every refusal the same way (a 400 or a 401) and log the reason:
 * telling the sender which check failed helps only somebody guessing.
 */
export type WebhookVerdict = { ok: true } | { ok: false; reason: WebhookRefusalReason };

interface VerifyCommon {
  /**
   * Every secret still allowed to sign: the current one, and the old one while a rotation is
   * under way. An unset one is skipped, so `[env.SECRET, env.OLD_SECRET]` works as written, and
   * when none is set the answer is `no-secret`.
   */
  secrets: readonly (string | undefined)[];
  /** The RAW body. Parsed and serialized again, JSON is a different string and never matches. */
  body: string;
  /** Default 300, the Standard Webhooks default. */
  toleranceSecs?: number;
  /** Milliseconds since the epoch. For a test. */
  now?: number;
}

/** A new secret: `whsec_` and 24 random bytes in base64. Either format can sign with it. */
export function newWebhookSecret(): string {
  return SECRET_PREFIX + base64Of(crypto.getRandomValues(new Uint8Array(24)));
}

/**
 * The header value for one delivery: `t=<unix seconds>,v1=<hex>`. Set it under your own name
 * (`x-<product>-signature`).
 *
 * Sign each ATTEMPT, not each event: a retry four minutes later needs a fresh `t`, or it arrives
 * already stale.
 */
export async function signWebhook(input: {
  secret: string;
  body: string;
  now?: number;
}): Promise<string> {
  const t = unixSeconds(input.now);
  return `t=${t},v1=${await hmacSha256(input.secret, `${t}.${input.body}`, "hex")}`;
}

/**
 * Checks a `t=<unix seconds>,v1=<hex>` header. Every `v1` in it is tried, because a sender in
 * the middle of a rotation signs with both secrets.
 *
 *     const verdict = await verifyWebhook({
 *       secrets: [env.WEBHOOK_SECRET],
 *       header: c.req.header("x-acme-signature"),
 *       body: await c.req.text(),
 *     });
 *     if (!verdict.ok) throw errors.badSignature(); // and log verdict.reason
 */
export async function verifyWebhook(
  input: VerifyCommon & { header: string | null | undefined },
): Promise<WebhookVerdict> {
  const secrets = input.secrets.filter(isSet);
  if (secrets.length === 0) return refused("no-secret");
  if (!input.header) return refused("missing-header");

  const stamps: string[] = [];
  const signatures: string[] = [];
  for (const part of input.header.split(",")) {
    const [key, value = ""] = part.trim().split("=", 2);
    if (key === "t") stamps.push(value);
    if (key === "v1" && value) signatures.push(value);
  }
  // One `t`, or the age could be checked on one and the signature on another.
  const [t] = stamps;
  if (stamps.length !== 1 || t === undefined || !isUnixSeconds(t) || signatures.length === 0)
    return refused("malformed");
  if (isStale(t, input)) return refused("stale");

  for (const secret of secrets) {
    const expected = await hmacSha256(secret, `${t}.${input.body}`, "hex");
    if (signatures.some((signature) => safeEqual(signature, expected))) return { ok: true };
  }
  return refused("bad-signature");
}

export interface StandardWebhookHeaders {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
}

/**
 * The three headers for one delivery, to spread into the request's headers.
 *
 * Keep `id` the same across retries of one event, so a receiver can drop the repeats, and sign
 * each attempt again, so the timestamp is fresh.
 */
export async function signStandardWebhook(input: {
  secret: string;
  id: string;
  body: string;
  now?: number;
}): Promise<StandardWebhookHeaders> {
  const timestamp = String(unixSeconds(input.now));
  const signed = `${input.id}.${timestamp}.${input.body}`;
  return {
    "webhook-id": input.id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${await hmacSha256(keyOf(input.secret), signed, "base64")}`,
  };
}

/**
 * Checks a Standard Webhooks call, such as a Supabase Auth hook.
 *
 * A secret can be `whsec_…`, or `v1,whsec_…` as Supabase prints it. Every `v1` signature in the
 * header is tried, separated by spaces as the spec says or by `", "` as Supabase Auth sends
 * them. One verifier in the fleet split on a single space and so refused every hook whenever its
 * secret was the first of two.
 *
 * Throws when a secret is not base64 after its prefix: that is a config mistake, and failing
 * every call loudly beats checking against the wrong key.
 */
export async function verifyStandardWebhook(
  input: VerifyCommon & { headers: Headers },
): Promise<WebhookVerdict> {
  const keys = input.secrets.filter(isSet).map(keyOf);
  if (keys.length === 0) return refused("no-secret");

  const id = input.headers.get("webhook-id");
  const timestamp = input.headers.get("webhook-timestamp");
  const header = input.headers.get("webhook-signature");
  if (!id || !timestamp || !header) return refused("missing-header");

  const signatures = [...header.matchAll(/(?:^|[\s,])v1,([A-Za-z0-9+/=]+)/g)].map(
    ([, signature = ""]) => signature,
  );
  if (!isUnixSeconds(timestamp) || signatures.length === 0) return refused("malformed");
  if (isStale(timestamp, input)) return refused("stale");

  for (const key of keys) {
    const expected = await hmacSha256(key, `${id}.${timestamp}.${input.body}`, "base64");
    if (signatures.some((signature) => safeEqual(signature, expected))) return { ok: true };
  }
  return refused("bad-signature");
}

function keyOf(secret: string): Uint8Array {
  const encoded = secret.replace(/^v1,/, "").replace(/^whsec_/, "");
  try {
    return bytesOfBase64(encoded);
  } catch {
    // The secret stays out of the message: this is thrown into a log.
    throw new TypeError("A Standard Webhooks secret must be base64 after `whsec_`");
  }
}

function isSet(secret: string | undefined): secret is string {
  return secret !== undefined && secret !== "";
}

function refused(reason: WebhookRefusalReason): WebhookVerdict {
  return { ok: false, reason };
}

function unixSeconds(now = Date.now()): number {
  return Math.floor(now / 1000);
}

function isUnixSeconds(text: string): boolean {
  return /^\d{1,12}$/.test(text);
}

function isStale(stamp: string, input: VerifyCommon): boolean {
  const tolerance = input.toleranceSecs ?? DEFAULT_TOLERANCE_SECS;
  return Math.abs(unixSeconds(input.now) - Number(stamp)) > tolerance;
}
