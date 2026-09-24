import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hmacSha256, safeEqual } from "./crypto.ts";

describe("safeEqual", () => {
  it("answers equal and unequal inputs", () => {
    expect(safeEqual("a1b2", "a1b2")).toBe(true);
    expect(safeEqual("a1b2", "a1b3")).toBe(false);
    expect(safeEqual("a1b2", "x1b2")).toBe(false);
    expect(safeEqual("a1b2", "a1b")).toBe(false);
    expect(safeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(safeEqual("AB", new Uint8Array([65, 66]))).toBe(true);
  });

  it("never lets two empty inputs through", () => {
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual(new Uint8Array(0), new Uint8Array(0))).toBe(false);
  });

  it("compares bytes, so a multibyte character fails instead of throwing", () => {
    // Same string length, different byte length: the case that threw a RangeError in one copy.
    expect(() => safeEqual("é", "e")).not.toThrow();
    expect(safeEqual("é", "e")).toBe(false);
    expect(safeEqual("é", "é")).toBe(true);
  });
});

describe("hmacSha256", () => {
  it("matches RFC 4231 test case 2, and node:crypto in base64", async () => {
    const message = "what do ya want for nothing?";
    expect(await hmacSha256("Jefe", message, "hex")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(await hmacSha256("Jefe", message, "base64")).toBe(
      createHmac("sha256", "Jefe").update(message).digest("base64"),
    );
  });

  it("takes a key as bytes", async () => {
    const key = new Uint8Array([0, 1, 2, 255]);
    expect(await hmacSha256(key, "body", "hex")).toBe(
      createHmac("sha256", key).update("body").digest("hex"),
    );
  });

  it("refuses an empty key, which node:crypto would sign with", async () => {
    await expect(hmacSha256("", "body", "hex")).rejects.toThrow("must not be empty");
  });
});
