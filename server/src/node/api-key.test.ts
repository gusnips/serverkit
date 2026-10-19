import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApiKeyCodec } from "./api-key.ts";

const { generateApiKey, hashApiKey, displayPrefix, looksLikeApiKey, isWellFormedApiKey } =
  createApiKeyCodec({ prefix: "ac_" });

describe("createApiKeyCodec", () => {
  it("mints the prefix and 32 lowercase hex characters, never the same twice", () => {
    const keys = Array.from({ length: 500 }, generateApiKey);
    expect(new Set(keys).size).toBe(500);
    for (const key of keys) {
      expect(key).toMatch(/^ac_[0-9a-f]{32}$/);
      expect(isWellFormedApiKey(key)).toBe(true);
      expect(looksLikeApiKey(key)).toBe(true);
    }
  });

  it("hashes a key minted before the kit to the bytes already stored", () => {
    // Computed outside this code with `printf %s <key> | shasum -a 256`. A change here would
    // orphan every stored key.
    const stored = "ac_0123456789abcdef0123456789abcdef";
    expect(isWellFormedApiKey(stored)).toBe(true);
    expect(hashApiKey(stored)).toBe(
      "af0baec6de29129ca6b961623c6b22f0d89e7d71e2aa3f1c094e2568d221fd0b",
    );
    expect(displayPrefix(stored)).toBe("ac_012345678");
  });

  it("hashes the whole key with SHA-256, and the hash never holds the secret", () => {
    const key = generateApiKey();
    expect(hashApiKey(key)).toBe(createHash("sha256").update(key).digest("hex"));
    expect(hashApiKey(key)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashApiKey(key)).not.toBe(hashApiKey(generateApiKey()));
    expect(hashApiKey(key)).not.toContain(key.slice(3));
  });

  it("shows 12 characters: enough to tell keys apart, not enough to use one", () => {
    const key = generateApiKey();
    expect(displayPrefix(key)).toBe(key.slice(0, 12));
    expect(displayPrefix(key).length).toBeLessThan(key.length / 2);
  });

  it("tells a key from a session token and from another brand's key", () => {
    expect(looksLikeApiKey("eyJhbGciOiJIUzI1NiJ9.eyJzdWIi.c2ln")).toBe(false);
    expect(looksLikeApiKey("sk_live_deadbeef")).toBe(false);
    const other = createApiKeyCodec({ prefix: "zz_" });
    expect(isWellFormedApiKey(other.generateApiKey())).toBe(false);
    expect(other.isWellFormedApiKey(generateApiKey())).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["the prefix alone", "ac_"],
    ["another brand", `zz_${"a".repeat(32)}`],
    ["uppercase hex", `ac_${"A".repeat(32)}`],
    ["an uppercase prefix", `AC_${"a".repeat(32)}`],
    ["31 characters", `ac_${"a".repeat(31)}`],
    ["33 characters", `ac_${"a".repeat(33)}`],
    ["a letter past f", `ac_${"a".repeat(31)}z`],
    ["a trailing newline", `ac_${"a".repeat(32)}\n`],
    ["a newline in place of the last character", `ac_${"a".repeat(31)}\n`],
    ["a leading space", ` ac_${"a".repeat(32)}`],
    ["a trailing space", `ac_${"a".repeat(32)} `],
    ["text in front", `xac_${"a".repeat(32)}`],
    ["text behind", `ac_${"a".repeat(32)} OR 1=1`],
  ])("refuses %s before any lookup", (_, token) => {
    expect(isWellFormedApiKey(token)).toBe(false);
  });

  it("reads the prefix as a literal, not a pattern", () => {
    // A copy that built `new RegExp(`^${prefix}…`)` accepted the second key below.
    const dotted = createApiKeyCodec({ prefix: "a.b_" });
    expect(dotted.isWellFormedApiKey(dotted.generateApiKey())).toBe(true);
    expect(dotted.isWellFormedApiKey(`aXb_${"a".repeat(32)}`)).toBe(false);
    expect(dotted.looksLikeApiKey(`aXb_${"a".repeat(32)}`)).toBe(false);
  });

  it("refuses an empty prefix, which would make every token look like a key", () => {
    expect(() => createApiKeyCodec({ prefix: "" })).toThrow(TypeError);
  });
});
