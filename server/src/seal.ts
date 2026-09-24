/**
 * Encrypting a secret you store (an OAuth token, a mailbox password) so a copy of the database is
 * not a copy of the secret. AES-256-GCM on Web Crypto, so a Worker runs it too.
 *
 * A sealed value reads `<key id>.<iv>.<tag>.<ciphertext>`, in base64url. That is the format two
 * backends in the fleet already write with the id `v1`, so their stored rows open as they are.
 * Reading the first part as a key id is what makes a rotation possible: none of the six copies
 * could rotate, because each held exactly one key.
 *
 * What the six copies taught:
 * - **A 16-byte tag, always.** Node accepts a cut-short GCM tag unless told its length, so one
 *   copy opened a value whose tag was 4 bytes, and a forgery cost 2^32 tries instead of 2^128.
 * - **An empty string seals and opens.** Two copies threw on opening one.
 * - **The key is checked at boot.** Four copies asked for "32 random bytes" in a comment and
 *   checked only that the variable was set, so a one-letter key booted.
 * - **The key is imported once.** One copy derived it on every call, at least 67 ms of blocked
 *   event loop each, on the path that handles every inbound message.
 */
import { base64UrlOf, bytesOfBase64Url } from "./crypto.ts";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_ID = /^[a-z0-9]+$/;

/**
 * An AES-GCM key, as Web Crypto hands it back. Named by what `importKey` returns because the DOM
 * typings and Node's declare `CryptoKey` differently, and this package is checked under both.
 */
export type SealKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

export type SealErrorReason = "malformed" | "unknown-key" | "did-not-open";

/** Why a value did not open. The message names the likely cause and the fix, for the log. */
export class SealError extends Error {
  readonly reason: SealErrorReason;
  constructor(reason: SealErrorReason, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SealError";
    this.reason = reason;
  }
}

export interface SealerOptions {
  /** The key id new values are sealed with. */
  current: string;
  /**
   * Every key that may open a stored value, by id: lowercase letters and digits, such as `v1`.
   * A key is 32 random bytes in base64 (`openssl rand -base64 32`), or a `SealKey`, such as the
   * one `scryptSealKey` in `@gusnips/server/node` derives for rows sealed under a passphrase.
   */
  keys: Readonly<Record<string, string | SealKey>>;
}

export interface Sealer {
  seal(plaintext: string): Promise<string>;
  /** Throws a `SealError` for a value it cannot open. */
  open(sealed: string): Promise<string>;
}

/**
 * Checks every key now, so a wrong one fails at boot rather than at the first stored secret.
 *
 *     const vault = createSealer({ current: "v1", keys: { v1: env.SEAL_KEY } });
 *     const sealed = await vault.seal(token); // "v1.Xq3…"
 *     await vault.open(sealed); // token
 *
 * To rotate: add the new key, point `current` at it, seal each stored value again (the rows
 * whose value starts with the old id), then remove the old key.
 */
export function createSealer(options: SealerOptions): Sealer {
  const { current } = options;
  // A Map, so a stored value naming a key "constructor" finds no key rather than Object's.
  const keys = new Map(Object.entries(options.keys));
  for (const [id, key] of keys) checkKey(id, key);
  const currentKey = keys.get(current);
  if (currentKey === undefined)
    throw new TypeError(`The current seal key "${current}" is not one of the keys given`);

  // Imported on first use, so creating a sealer stays sync and runs no crypto.
  const imported = new Map<string, Promise<SealKey>>();
  function importOnce(id: string, key: string | SealKey): Promise<SealKey> {
    let promise = imported.get(id);
    if (!promise) {
      promise =
        typeof key === "string"
          ? crypto.subtle.importKey("raw", bytesOfBase64Url(key), "AES-GCM", false, [
              "encrypt",
              "decrypt",
            ])
          : Promise.resolve(key);
      imported.set(id, promise);
    }
    return promise;
  }

  return {
    async seal(plaintext) {
      const key = await importOnce(current, currentKey);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, tagLength: TAG_BYTES * 8 },
          key,
          new TextEncoder().encode(plaintext),
        ),
      );
      // Web Crypto appends the tag to the ciphertext. The format keeps them apart.
      const ciphertext = encrypted.subarray(0, encrypted.length - TAG_BYTES);
      const tag = encrypted.subarray(encrypted.length - TAG_BYTES);
      return [current, base64UrlOf(iv), base64UrlOf(tag), base64UrlOf(ciphertext)].join(".");
    },

    async open(sealed) {
      const parts = sealed.split(".");
      const [id = "", ...encoded] = parts;
      const decoded = parts.length === 4 && KEY_ID.test(id) ? decodeAll(encoded) : null;
      const [iv, tag, ciphertext] = decoded ?? [];
      if (!iv || !tag || !ciphertext || iv.length !== IV_BYTES || tag.length !== TAG_BYTES)
        throw new SealError(
          "malformed",
          "This is not a sealed value: expected <key id>.<iv>.<tag>.<ciphertext>, with a 12-byte " +
            "iv and a 16-byte tag. It was stored without seal(), or it was cut short or edited.",
        );
      const stored = keys.get(id);
      if (stored === undefined)
        throw new SealError(
          "unknown-key",
          `This value was sealed with the key "${id}", which this process does not have. Add ` +
            `that key to the sealer's keys, or seal the value again.`,
        );
      const key = await importOnce(id, stored);
      const joined = new Uint8Array(ciphertext.length + TAG_BYTES);
      joined.set(ciphertext);
      joined.set(tag, ciphertext.length);
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, tagLength: TAG_BYTES * 8 },
          key,
          joined,
        );
        return new TextDecoder().decode(plain);
      } catch (cause) {
        // GCM refuses a wrong key and a changed value the same way. The wrong key is the case an
        // operator can fix, so the message leads with it.
        throw new SealError(
          "did-not-open",
          `The sealed value did not open. The key "${id}" on this process is not the one that ` +
            `sealed it, or the stored value was changed.`,
          { cause },
        );
      }
    },
  };
}

function checkKey(id: string, key: string | SealKey): void {
  if (!KEY_ID.test(id))
    throw new TypeError(`A seal key id is lowercase letters and digits, such as "v1", not "${id}"`);
  if (typeof key !== "string") {
    if (key.algorithm.name !== "AES-GCM")
      throw new TypeError(`The seal key "${id}" is an ${key.algorithm.name} key, not AES-GCM`);
    return;
  }
  let length: number;
  try {
    length = bytesOfBase64Url(key).length;
  } catch {
    length = -1;
  }
  // The key stays out of the message: this is thrown into a boot log.
  if (length !== KEY_BYTES)
    throw new TypeError(
      `The seal key "${id}" must be 32 bytes in base64 ` +
        (length < 0 ? "and is not base64" : `and is ${length}`) +
        ". Make one with `openssl rand -base64 32`.",
    );
}

function decodeAll(encoded: string[]): Uint8Array<ArrayBuffer>[] | null {
  try {
    return encoded.map((part) => bytesOfBase64Url(part));
  } catch {
    return null;
  }
}
