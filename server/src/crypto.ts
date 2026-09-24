/**
 * The pieces under webhook signatures: an HMAC, a comparison that does not leak, and the byte
 * encodings between them. Web Crypto only, so a Worker runs them as they are, and async wherever
 * Web Crypto is, because a Worker has no sync version of it.
 */

const encoder = new TextEncoder();

function bytesOf(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? encoder.encode(value) : value;
}

/**
 * Whether two signatures or secrets are equal, in a time that does not depend on where they
 * first differ. Strings are compared as their UTF-8 bytes.
 *
 * - **`false` when either side is empty.** Five copies in the fleet answered `true` for
 *   `("", "")`, so an unset secret checked against a missing header let the request through.
 * - **It never throws.** One copy checked the string lengths and then compared the bytes, so a
 *   signature holding one multibyte character threw instead of failing.
 * - **It does not hide the length.** Unequal lengths return at once. The length of a MAC or a
 *   hash is fixed by its algorithm, so there is nothing to hide there.
 *
 * Sync, unlike the rest of this file, because it calls no Web Crypto.
 */
export function safeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const left = bytesOf(a);
  const right = bytesOf(b);
  if (left.length === 0 || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return difference === 0;
}

/**
 * HMAC-SHA256 of `message`, as hex or base64. A string key is used as its UTF-8 bytes, whole.
 * Throws on an empty key rather than let the runtime decide: Web Crypto refuses one, and Node's
 * own `createHmac` signs with it, so a forger who knows the secret is unset can sign too.
 *
 * A vendor's scheme is one line on top of it, next to its route:
 *
 *     safeEqual(header, `sha256=${await hmacSha256(secret, body, "hex")}`)
 */
export async function hmacSha256(
  key: string | Uint8Array,
  message: string,
  encoding: "hex" | "base64",
): Promise<string> {
  // A copy, because Web Crypto takes only a view over a plain ArrayBuffer.
  const raw = new Uint8Array(bytesOf(key));
  if (raw.length === 0) throw new TypeError("An HMAC key must not be empty");
  const imported = await crypto.subtle.importKey(
    "raw",
    raw,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(message)));
  return encoding === "hex" ? hexOf(mac) : base64Of(mac);
}

function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Throws a `DOMException` on text that is not base64. */
export function bytesOfBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}
