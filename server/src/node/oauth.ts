/**
 * The two lines of `/oauth` setup every server adopter wrote by hand: the signing secret, taken
 * from a secret the server already keeps, and the client-document fetch that refuses a private
 * address. Here because both need Node: a synchronous HMAC, so `createOAuth` can be built when the
 * app is composed, and `fetchPublic`'s DNS check, which a Worker cannot run.
 */
import { createHmac } from "node:crypto";
import { isPlaceholder } from "../env.ts";
import { fetchPublic } from "./public-fetch.ts";

/** `validateEnv`'s floor for a secret. */
const MIN_SECRET_LENGTH = 32;

/**
 * `createOAuth`'s `secret`, derived from a secret your server already keeps, so there is no new
 * variable to set, and the OAuth key stays apart from whatever else `root` signs: the HMAC-SHA256
 * of `label`, keyed with `root`, in base64url. The same input gives the same key on every instance
 * and every deploy.
 *
 *     createOAuth({ ..., secret: deriveOAuthSigningKey(env.SERVICE_SECRET) });
 *
 * A client id is a signature, and claude.ai and ChatGPT keep one forever, so the key must never
 * change under a connected app. Already deriving one by hand? Pass the label you signed with, and
 * pin a key your old code made in a test. Derived another way (HKDF, another encoding)? Keep your
 * own line: switching to this one disconnects every app.
 *
 * Rotating `root` unregisters every connected app: their keys keep working, and each signs in
 * again the next time it needs a new one. Throws when `root` is shorter than 32 characters or
 * looks like an `.env.example` placeholder, so a server never signs with a key anyone can guess.
 */
export function deriveOAuthSigningKey(root: string, label = "oauth:v1"): string {
  if (root.length < MIN_SECRET_LENGTH)
    throw new TypeError(
      `The secret the OAuth key is derived from is ${root.length} characters. It needs at least ${MIN_SECRET_LENGTH}.`,
    );
  if (isPlaceholder(root))
    throw new TypeError(
      "The secret the OAuth key is derived from looks like a placeholder from .env.example. Set the real secret.",
    );
  if (label === "") throw new TypeError("The OAuth key's label is empty.");
  return createHmac("sha256", root).update(label).digest("base64url");
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
