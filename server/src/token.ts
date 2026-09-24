/**
 * A token your server writes, hands to a person, and reads back later with no session behind it:
 * an unsubscribe link, an OAuth `state`, an approval link. Signed, not encrypted, so the payload
 * is readable by whoever holds the token. Put nothing secret in it.
 *
 * A token reads `<payload>.<signature>`, or `<payload>.<expiry>.<signature>` when it expires,
 * with the payload in base64url and the expiry in unix seconds.
 *
 * **The purpose is in the key.** The signing key is the HMAC of the secret and the purpose, so
 * the secret never signs anything itself, and a token made for one purpose cannot be used for
 * another. That also lets a service key you already hold be the secret, with no new variable.
 * Five backends in the fleet sign their unsubscribe links exactly this way, and a token without
 * an expiry is byte-for-byte theirs, so links already sent keep working after the switch. Three
 * other designs signed with an encryption key, and one with the service key itself.
 */
import { base64UrlOf, bytesOfBase64Url, hmacBytes, safeEqual } from "./crypto.ts";

// ponytail: nothing binds an outside value (a username) into the signature. In this format,
// MAC-ing `<payload>.<value>` would let a caller who picks the value move the expiry into it and
// drop it. Put the value in the payload and compare it after verifying; if that is ever not
// enough, the upgrade is a key derived from the value.
const SHAPE = /^([A-Za-z0-9_-]+)(?:\.(\d{1,12}))?\.([A-Za-z0-9_-]{43})$/;

export type TokenRefusalReason =
  | "malformed"
  | "bad-signature"
  /** Signed by you, and past its expiry. Safe to say so: "this link expired, ask for a new one". */
  | "expired";

export type TokenVerdict =
  | { ok: true; payload: string; expiresAt: number | null }
  | { ok: false; reason: TokenRefusalReason };

interface TokenCommon {
  /** 32 random bytes or more, or a service key you already hold. The purpose is mixed in first. */
  secret: string;
  /** What the token is for, such as `"unsubscribe:v1"`. Another purpose never verifies it. */
  purpose: string;
  /** Milliseconds since the epoch. For a test. */
  now?: number;
}

/**
 * Signs `payload` for one purpose. Leave out `ttlSecs` only for a link that must work forever,
 * such as unsubscribe: RFC 8058's button sits in mail somebody archived, which is exactly when
 * they reach for it.
 *
 *     const token = await signToken({ secret, purpose: "unsubscribe:v1", payload: userId });
 *
 * For structured data, pass `JSON.stringify(data)` and parse it after `verifyToken`.
 */
export async function signToken(
  input: TokenCommon & { payload: string; ttlSecs?: number },
): Promise<string> {
  const { payload, ttlSecs } = input;
  if (!payload) throw new TypeError("A token's payload must not be empty");
  if (ttlSecs !== undefined && !(Number.isInteger(ttlSecs) && ttlSecs > 0))
    throw new TypeError(`A token's ttlSecs is a whole number of seconds above 0, not ${ttlSecs}`);
  const encoded = base64UrlOf(new TextEncoder().encode(payload));
  const signed =
    ttlSecs === undefined
      ? encoded
      : `${encoded}.${Math.floor((input.now ?? Date.now()) / 1000) + ttlSecs}`;
  return `${signed}.${await signatureOf(input, signed)}`;
}

/**
 * The payload, or why not. The signature is checked before the expiry, so `expired` means you
 * signed it; everything else can be anybody's. On a public page, answer every refusal the same
 * way and log the reason.
 */
export async function verifyToken(input: TokenCommon & { token: string }): Promise<TokenVerdict> {
  // The shape first, so a token that passes is only base64url, digits and dots, and safe to
  // write back into a page.
  const match = SHAPE.exec(input.token);
  if (!match) return { ok: false, reason: "malformed" };
  const [, encoded = "", expiry, signature = ""] = match;
  const signed = expiry === undefined ? encoded : `${encoded}.${expiry}`;
  if (!safeEqual(signature, await signatureOf(input, signed)))
    return { ok: false, reason: "bad-signature" };

  const expiresAt = expiry === undefined ? null : Number(expiry) * 1000;
  if (expiresAt !== null && (input.now ?? Date.now()) > expiresAt)
    return { ok: false, reason: "expired" };
  return { ok: true, payload: new TextDecoder().decode(bytesOfBase64Url(encoded)), expiresAt };
}

async function signatureOf(input: TokenCommon, signed: string): Promise<string> {
  if (!input.purpose) throw new TypeError("A token's purpose must not be empty");
  const key = await hmacBytes(input.secret, input.purpose);
  return base64UrlOf(await hmacBytes(key, signed));
}
