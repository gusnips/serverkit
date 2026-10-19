import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveOAuthSigningKey, fetchClientDocument } from "./oauth.ts";

const ROOT = "a-shared-server-secret-of-forty-bytes-x";

describe("deriveOAuthSigningKey", () => {
  it("is the key adopters derived by hand, byte for byte", () => {
    expect(deriveOAuthSigningKey(ROOT)).toBe(
      createHmac("sha256", ROOT).update("oauth:v1").digest("base64url"),
    );
    // Pinned, so a changed default or algorithm fails here before it disconnects anybody's apps.
    expect(deriveOAuthSigningKey(ROOT)).toBe("ho2wTSibPWIkyIJ7x9ahXb43hUFNmmLbspEB8YKnF0I");
  });

  it("signs under the label an adopter already used", () => {
    expect(deriveOAuthSigningKey(ROOT, "app:oauth:v1")).toBe(
      createHmac("sha256", ROOT).update("app:oauth:v1").digest("base64url"),
    );
    expect(deriveOAuthSigningKey(ROOT, "app:oauth:v1")).toBe(
      "va_4We6dE9_qlD_SX5wgkqymrMCB8coRpujdu4PMSmQ",
    );
    expect(() => deriveOAuthSigningKey(ROOT, "")).toThrow(TypeError);
  });

  it("refuses a secret anyone could guess", () => {
    expect(() => deriveOAuthSigningKey("")).toThrow(TypeError);
    expect(() => deriveOAuthSigningKey("x".repeat(31))).toThrow(/31 characters/);
    expect(() => deriveOAuthSigningKey("dev-egress-secret-change-me-0123456789")).toThrow(
      /placeholder/,
    );
    expect(() => deriveOAuthSigningKey("<generate: openssl rand -base64 32>")).toThrow(
      /placeholder/,
    );
    expect(deriveOAuthSigningKey("k".repeat(32))).toHaveLength(43);
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
