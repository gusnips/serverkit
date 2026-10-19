/**
 * An API key's bytes: mint, hash, show, recognise. Storage, owners, grants and caps stay with the
 * product. Five backends mint the same key with only the prefix changed: the prefix, then 16
 * random bytes as 32 lowercase hex, SHA-256 of the whole key, 12 characters kept for display. A
 * key any of them minted hashes here to the same bytes, so no stored row changes.
 *
 * In `/node` because every one of them hashes synchronously with `node:crypto`, on the auth hot
 * path. Web Crypto's digest is async, and moving to it would change every caller.
 */
import { createHash, randomBytes } from "node:crypto";

/** 16 random bytes, 128 bits. A key is a random token, so a leak is the only way in. */
const SECRET_HEX_LENGTH = 32;

/** The prefix and the first characters of the secret: enough to tell keys apart in a list, far
 *  too few to use one. Twelve in every donor, and stored beside the hash, so it cannot change. */
const DISPLAY_LENGTH = 12;

const LOWERCASE_HEX = /^[0-9a-f]+$/;

export interface ApiKeyCodecOptions {
  /** Your brand's literal, such as `"ac_"`. Not a pattern: a `.` in it is a dot. */
  prefix: string;
}

/** Plain functions, so you can destructure them and export each under its own name. */
export interface ApiKeyCodec {
  /** A new key. The return value IS the secret: store only its hash and its display prefix. */
  generateApiKey: () => string;
  /** SHA-256 of the whole key, as 64 lowercase hex characters. Look a key up by this. */
  hashApiKey: (key: string) => string;
  /** The first 12 characters, safe to store and to show. */
  displayPrefix: (key: string) => string;
  /** Starts with your prefix. Tells a key from a session token, to answer "wrong door". */
  looksLikeApiKey: (token: string) => boolean;
  /** Exactly the shape `generateApiKey` mints. Ask before the lookup, to save a round trip. */
  isWellFormedApiKey: (token: string) => boolean;
}

/**
 * The five functions every backend with API keys writes, bound to its prefix.
 *
 *     export const { generateApiKey, hashApiKey, displayPrefix, looksLikeApiKey, isWellFormedApiKey } =
 *       createApiKeyCodec({ prefix: "ac_" });
 *
 * The hash is plain SHA-256 rather than a password hash on purpose: the input is 128 random bits,
 * not something a person chose, so there is no dictionary to slow down, and the lookup stays one
 * indexed read.
 */
export function createApiKeyCodec({ prefix }: ApiKeyCodecOptions): ApiKeyCodec {
  // An empty prefix makes every token "look like" a key, so a session token is sent to the key
  // lookup and refused as a bad key instead of being told it knocked on the wrong door.
  if (!prefix) throw new TypeError('createApiKeyCodec needs a prefix, such as "ac_"');
  const keyLength = prefix.length + SECRET_HEX_LENGTH;

  return {
    generateApiKey: () => prefix + randomBytes(SECRET_HEX_LENGTH / 2).toString("hex"),
    hashApiKey: (key) => createHash("sha256").update(key).digest("hex"),
    displayPrefix: (key) => key.slice(0, DISPLAY_LENGTH),
    looksLikeApiKey: (token) => token.startsWith(prefix),
    // The literal prefix, never a pattern built from it. Three copies wrote
    // `new RegExp(`^${prefix}[0-9a-f]{32}$`)`, which is right only while the prefix holds no
    // regex character: with `a.b_`, it accepts `aXb_…`.
    isWellFormedApiKey: (token) =>
      token.length === keyLength &&
      token.startsWith(prefix) &&
      LOWERCASE_HEX.test(token.slice(prefix.length)),
  };
}
