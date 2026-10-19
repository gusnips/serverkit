import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveOAuthSigningKey, fetchClientDocument } from "./oauth.ts";

const SHARED = "a-shared-server-secret-of-forty-bytes-x";

describe("deriveOAuthSigningKey", () => {
  it("is the key every adopter derived by hand, byte for byte", () => {
    expect(deriveOAuthSigningKey(SHARED)).toBe(
      createHmac("sha256", SHARED).update("oauth:v1").digest("base64url"),
    );
    // Pinned, so a changed label fails here before it disconnects anybody's apps.
    expect(deriveOAuthSigningKey(SHARED)).toBe("ho2wTSibPWIkyIJ7x9ahXb43hUFNmmLbspEB8YKnF0I");
  });

  it("refuses a secret too short to derive from", () => {
    expect(() => deriveOAuthSigningKey("")).toThrow(TypeError);
    expect(() => deriveOAuthSigningKey("x".repeat(31))).toThrow(TypeError);
    expect(deriveOAuthSigningKey("x".repeat(32))).toHaveLength(43);
  });
});

describe("fetchClientDocument", () => {
  it("never fetches a private or loopback address", async () => {
    for (const url of [
      "https://127.0.0.1/client.json",
      "https://10.0.0.8/client.json",
      "https://[::1]/client.json",
      "https://localhost/client.json",
    ])
      expect(await fetchClientDocument(new URL(url))).toBeNull();
  });
});
