/**
 * The two lines of `/oauth` setup every server adopter wrote by hand: the signing secret, taken
 * from a secret the server already keeps, and the client-document fetch that refuses a private
 * address. Here because both need Node: a synchronous HMAC, so `createOAuth` can be built when the
 * app is composed, and `fetchPublic`'s DNS check, which a Worker cannot run.
 */
import { createHmac } from "node:crypto";
import { fetchPublic } from "./public-fetch.ts";

/**
 * The label every adopter signed with. A client id is a signature, and claude.ai and ChatGPT keep
 * one forever, so a different label would disconnect every app already connected. Fixed here so no
 * adopter can drift from it.
 */
const SIGNING_LABEL = "oauth:v1";

/** The same floor `createOAuth` puts on its own secret. */
const MIN_SECRET_BYTES = 32;

/**
 * `createOAuth`'s `secret`, derived from a secret your server already keeps, so there is no new
 * variable to set, and the OAuth key stays apart from whatever else `shared` signs. The same input
 * gives the same key on every instance and every deploy.
 *
 *     createOAuth({ ..., secret: deriveOAuthSigningKey(env.SERVICE_SECRET) });
 *
 * Rotating `shared` unregisters every connected app: their keys keep working, and each signs in
 * again the next time it needs a new one.
 */
export function deriveOAuthSigningKey(shared: string): string {
  if (Buffer.byteLength(shared) < MIN_SECRET_BYTES)
    throw new TypeError(
      `The secret an OAuth key is derived from must be at least ${MIN_SECRET_BYTES} bytes.`,
    );
  return createHmac("sha256", shared).update(SIGNING_LABEL).digest("base64url");
}

/**
 * `createOAuth`'s `fetchClientDocument` on a server: everything the default checks, plus every
 * address the name resolves to, so a client id cannot point the fetch at your own network. No
 * redirect is followed, and the whole fetch has five seconds.
 *
 *     createOAuth({ ..., fetchClientDocument });
 */
export async function fetchClientDocument(url: URL): Promise<Response | null> {
  const got = await fetchPublic(url, {
    maxRedirects: 0,
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  return got.ok ? got.response : null;
}
