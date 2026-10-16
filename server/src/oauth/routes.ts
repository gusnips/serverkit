/**
 * The public half of `createOAuth`: the two discovery documents, registration, the token endpoint
 * and the device flow's first step. Your consent and device pages are the other half, behind your
 * session.
 *
 * Every answer here is in OAuth's own shape, a top-level `error`, never your envelope: a client
 * reads `error` and nothing else. Any web page may call these (`Access-Control-Allow-Origin: *`),
 * because a browser-based client such as the MCP Inspector runs discovery from the page, and none
 * of them reads a cookie.
 */
import { Hono, type Context, type Env } from "hono";
import { cors } from "hono/cors";
import { bytesOfBase64 } from "../crypto.ts";
import type { ClientCredentials, OAuth, OAuthAnswer } from "./index.ts";

const decoder = new TextDecoder();

/**
 * Mount it at the root, beside your door, and put a rate limit on the device route: anyone may
 * start a sign-in, and each one is a row.
 *
 *     app.use("/oauth/device_authorization", rateLimit({ ... }));
 *     app.route("/", oauthRoutes(oauth));
 */
export function oauthRoutes<E extends Env = Env>(oauth: OAuth): Hono<E> {
  const r = new Hono<E>();
  // Path by path, never `"*"`: mounted at the root, a `"*"` here becomes `"/*"` in your app, and
  // every route you add after it would answer any origin, preflight included.
  // No `allowHeaders`, so a preflight gets back the headers it asked for: the MCP SDK sends
  // `MCP-Protocol-Version` on discovery, and no cookie rides on any of these.
  const anyOrigin = cors({ origin: "*" });
  for (const path of [
    "/.well-known/oauth-protected-resource",
    oauth.metadataPath,
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/token",
    "/oauth/device_authorization",
  ])
    r.use(path, anyOrigin);

  // RFC 9728 lets a client read either. The MCP spec tries the one with the door's path first.
  const resource = (c: Context<E>) => c.json(oauth.protectedResourceMetadata());
  r.get("/.well-known/oauth-protected-resource", resource);
  r.get(oauth.metadataPath, resource);
  r.get("/.well-known/oauth-authorization-server", (c) =>
    c.json(oauth.authorizationServerMetadata()),
  );

  // `no-store` too: a confidential client's answer carries its secret.
  r.post("/oauth/register", async (c) =>
    answer(c, await oauth.register(await c.req.json().catch(() => null)), true),
  );
  r.post("/oauth/token", async (c) =>
    answer(c, await oauth.token(await fieldsOf(c), basicCredentials(c)), true),
  );
  r.post("/oauth/device_authorization", async (c) =>
    answer(c, await oauth.deviceAuthorization(await fieldsOf(c), basicCredentials(c)), true),
  );
  return r;
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
