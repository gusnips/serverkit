/**
 * The key for rows a backend sealed under a passphrase with Node's scrypt. Web Crypto has no
 * scrypt, on Node or on Bun, which is why this is the one piece of sealing that lives in `/node`.
 */
import { scrypt } from "node:crypto";
import type { SealKey } from "../seal.ts";

/**
 * Derives the AES-GCM key `scryptSync(passphrase, salt, 32)` gives, with Node's default cost, so
 * a value sealed that way opens with `createSealer`. Async, so the derivation runs off the event
 * loop, and once: pass the key to `createSealer` and keep the sealer.
 *
 *     const vault = createSealer({
 *       current: "v1",
 *       keys: { v1: await scryptSealKey(env.CREDENTIALS_ENCRYPTION_KEY, "acme-credentials-v1") },
 *     });
 *
 * The salt is part of the key: change it and nothing stored opens. For new data, give
 * `createSealer` 32 random bytes instead, and skip the derivation.
 */
export async function scryptSealKey(passphrase: string, salt: string): Promise<SealKey> {
  if (!passphrase) throw new TypeError("The passphrase to derive a seal key from is empty");
  const raw = await new Promise<Buffer>((resolve, reject) =>
    scrypt(passphrase, salt, 32, (error, key) => (error ? reject(error) : resolve(key))),
  );
  return crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}
