/**
 * `createOAuth` on the wire, in two halves.
 *
 * `oauthRoutes` is the public half: the two discovery documents, registration, the token endpoint
 * and the device flow's first step. Every answer there is in OAuth's own shape, a top-level
 * `error`, never your envelope: a client reads `error` and nothing else. Any web page may call
 * them (`Access-Control-Allow-Origin: *`), because a browser-based client such as the MCP
 * Inspector runs discovery from the page, and none of them reads a cookie.
 *
 * `oauthConsoleRoutes` is what your consent and device pages call, behind your session, in your
 * envelope.
 */
import { Hono, type Context, type Env } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { bytesOfBase64 } from "../crypto.ts";
import { ok } from "../hono/responses.ts";
import { rateLimit } from "../hono/rate-limit.ts";
import { memoryWindowStore, type RefusedHit } from "../rate-limit.ts";
import type { ClientCredentials, OAuth, OAuthAnswer, OAuthRefusal } from "./index.ts";

const decoder = new TextDecoder();

const PROTECTED_RESOURCE = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER = "/.well-known/oauth-authorization-server";
const POSTED = ["/oauth/register", "/oauth/token", "/oauth/device_authorization"];
/** A registration is a few URLs and a name. Every adopter capped these bodies at 64 KiB. */
const BODY_MAX_BYTES = 64 * 1024;
/** Device sign-ins one caller may start a minute. A person starts one, maybe two. */
const DEVICE_STARTS_PER_MINUTE = 10;
/** An app's query string: a few URLs and a PKCE challenge. */
const QUERY_MAX_LENGTH = 8_192;
/** A user code, with room for the spaces and dash a person types. */
const CODE_MAX_LENGTH = 32;

export interface OAuthRoutesOptions<E extends Env = Env> {
  /**
   * Who is starting a device sign-in, for its limit of 10 a minute: the caller's address, read the
   * way your proxy allows, or `null` to let one through uncounted. Anyone may start one before
   * signing in, and each start writes a row.
   */
  deviceKey: (c: Context<E>) => string | null;
  /** Your own 429 for that limit, from your `errors` table. `hit.retryAfterSecs` is its wait. */
  refuse: (hit: RefusedHit, scope: string) => Error;
}

/**
 * Whether `oauthRoutes` answers this path. They set their own CORS, any origin and no cookie, so
 * skip your first-party CORS for them: a CORS middleware in front answers their preflight first.
 *
 *     app.use("*", (c, next) => (isOAuthPath(c.req.path) ? next() : firstPartyCors(c, next)));
 */
export function isOAuthPath(path: string): boolean {
  return (
    path === PROTECTED_RESOURCE ||
    path.startsWith(`${PROTECTED_RESOURCE}/`) ||
    path === AUTHORIZATION_SERVER ||
    POSTED.includes(path)
  );
}

/**
 * Mount it at the root, beside your door. It caps its bodies at 64 KiB and holds device sign-ins
 * to 10 a minute per caller; any wider limit you keep in front of every public route still applies.
 *
 *     app.route("/", oauthRoutes<AppEnv>(oauth, { deviceKey: addressOf, refuse: tooMany }));
 */
export function oauthRoutes<E extends Env = Env>(
  oauth: OAuth,
  options: OAuthRoutesOptions<E>,
): Hono<E> {
  const r = new Hono<E>();
  // Path by path, never `"*"`: mounted at the root, a `"*"` here becomes `"/*"` in your app, and
  // every route you add after it would answer any origin, preflight included.
  // No `allowHeaders`, so a preflight gets back the headers it asked for: the MCP SDK sends
  // `MCP-Protocol-Version` on discovery, and no cookie rides on any of these.
  const anyOrigin = cors({ origin: "*" });
  for (const path of [PROTECTED_RESOURCE, oauth.metadataPath, AUTHORIZATION_SERVER, ...POSTED])
    r.use(path, anyOrigin);

  // On the POST alone, so a preflight is not counted. Its body stays in OAuth's shape.
  const bounded = bodyLimit({
    maxSize: BODY_MAX_BYTES,
    onError: (c) =>
      c.json({ error: "invalid_request", error_description: "The body is over 64 KiB" }, 413),
  });
  // ponytail: counted in this process's memory, so N instances allow 10 x N a minute. That still
  // bounds the rows; a shared store is the upgrade if one caller ever spreads across instances.
  const deviceLimit = rateLimit<E>({
    scope: "oauth-device",
    store: memoryWindowStore(),
    limit: DEVICE_STARTS_PER_MINUTE,
    windowMs: 60_000,
    key: options.deviceKey,
    refuse: options.refuse,
  });

  // RFC 9728 lets a client read either. The MCP spec tries the one with the door's path first.
  const resource = (c: Context<E>) => c.json(oauth.protectedResourceMetadata());
  r.get("/.well-known/oauth-protected-resource", resource);
  r.get(oauth.metadataPath, resource);
  r.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(oauth.authorizationServerMetadata()),
  );

  // `no-store` too: a confidential client's answer carries its secret.
  r.post("/oauth/register", bounded, async (c) =>
    answer(c, await oauth.register(await c.req.json().catch(() => null)), true),
  );
  r.post("/oauth/token", bounded, async (c) =>
    answer(c, await oauth.token(await fieldsOf(c), basicCredentials(c)), true),
  );
  r.post("/oauth/device_authorization", deviceLimit, bounded, async (c) =>
    answer(c, await oauth.deviceAuthorization(await fieldsOf(c), basicCredentials(c)), true),
  );
  return r;
}

export interface OAuthConsoleOptions<E extends Env = Env> {
  /**
   * Who is saying yes, as the `subject` your `mintKey` gets back. It runs before every yes and
   * never before a no, so check here that they may have one more key, and throw your own error
   * when they may not: the page shows it beside the button, instead of the app failing later.
   * `choice` is whatever your page sent with the yes, such as a workspace, or `undefined`. It came
   * from the browser, so check it the way you would any input.
   */
  approver: (c: Context<E>, choice: unknown) => string | Promise<string>;
}

/**
 * The calls your consent page (`authorizePage`) and device page make, behind your own sign-in:
 * the server half of `@gusnips/react/oauth`'s hooks. Mount it under your session door.
 *
 *     app.route("/auth/oauth", oauthConsoleRoutes<AppEnv>(oauth, {
 *       async approver(c) {
 *         const user = c.get("user");
 *         await keys.assertRoomForOne(user.id);
 *         return user.id;
 *       },
 *     }));
 *
 * - `GET /request?<the query the app sent your page, as it came>`: the consent view.
 * - `POST /approve` with `{ query, choice? }`: the yes, and where to send the browser.
 * - `GET /device?code=WDJB-MJHT`: the device view.
 * - `POST /device` with `{ code, decision: "approve" | "deny", choice? }`.
 *
 * Each answers `{ data }`. A refusal is `{ data: { ok: false, reason, message } }`, an answer and
 * not an error, so the page words it and never redirects: an unknown app, a return address it
 * never registered, a code nobody is waiting on, or a body your own page would never send. What
 * `approver` throws is yours, and goes through your `onError`.
 */
export function oauthConsoleRoutes<E extends Env = Env>(
  oauth: OAuth,
  options: OAuthConsoleOptions<E>,
): Hono<E> {
  const r = new Hono<E>();
  r.get("/request", async (c) => {
    const query = new URL(c.req.url).search.slice(1);
    return ok(
      c,
      query.length > QUERY_MAX_LENGTH
        ? malformed()
        : await oauth.describe(new URLSearchParams(query)),
    );
  });
  r.post("/approve", async (c) => {
    const body = await jsonOf(c);
    if (typeof body?.query !== "string" || body.query.length > QUERY_MAX_LENGTH)
      return ok(c, malformed());
    const subject = await options.approver(c, body.choice);
    return ok(c, await oauth.approve(new URLSearchParams(body.query), subject));
  });
  r.get("/device", async (c) => ok(c, await oauth.describeDevice(c.req.query("code") ?? "")));
  r.post("/device", async (c) => {
    const body = await jsonOf(c);
    const code = body?.code;
    if (typeof code !== "string" || code.length > CODE_MAX_LENGTH) return ok(c, malformed());
    if (body?.decision === "deny") return ok(c, await oauth.decideDevice(code, "deny"));
    if (body?.decision !== "approve") return ok(c, malformed());
    const subject = await options.approver(c, body.choice);
    return ok(c, await oauth.decideDevice(code, { subject }));
  });
  return r;
}

/** A JSON object, or `null` for anything else. */
async function jsonOf<E extends Env>(c: Context<E>): Promise<Record<string, unknown> | null> {
  const body: unknown = await c.req.json().catch(() => null);
  return isRecord(body) ? body : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(): OAuthRefusal {
  return {
    ok: false,
    reason: "invalid-request",
    message: "This request is incomplete. Start the sign-in again from the app.",
  };
}

/** A token or a secret must never be cached between us and the client (RFC 6749 §5.1). */
function answer<E extends Env>(c: Context<E>, result: OAuthAnswer, noStore = false): Response {
  if (noStore) {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
  }
  if (result.status === 401) c.header("WWW-Authenticate", 'Basic realm="oauth"');
  return c.json(result.body, result.status);
}

/** OAuth's form encoding, or JSON, which some clients send: string fields either way. */
async function fieldsOf<E extends Env>(c: Context<E>): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  const raw: unknown = type.includes("application/json")
    ? await c.req.json().catch(() => ({}))
    : await c.req.parseBody().catch(() => ({}));
  const fields: Record<string, string> = {};
  if (typeof raw === "object" && raw !== null)
    for (const [key, value] of Object.entries(raw))
      if (typeof value === "string") fields[key] = value;
  return fields;
}

/** RFC 6749 §2.3.1: `Basic base64(urlencode(id):urlencode(secret))`. */
function basicCredentials<E extends Env>(c: Context<E>): ClientCredentials | null {
  const header = c.req.header("authorization");
  if (!header?.toLowerCase().startsWith("basic ")) return null;
  try {
    const decoded = decoder.decode(bytesOfBase64(header.slice(6).trim()));
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    return {
      id: decodeURIComponent(decoded.slice(0, colon)),
      secret: decodeURIComponent(decoded.slice(colon + 1)),
    };
  } catch {
    return null;
  }
}
