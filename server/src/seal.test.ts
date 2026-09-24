import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSealer, SealError } from "./seal.ts";

const RAW = Buffer.alloc(32, 7);
const KEY = RAW.toString("base64");
const OTHER = Buffer.alloc(32, 9).toString("base64");

/** The `v1.<iv>.<tag>.<ciphertext>` writer two backends in the fleet run today. */
function donorSeal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv, tag, ciphertext]
    .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
    .join(".");
}

/** And its reader. */
function donorOpen(key: Buffer, sealed: string): string {
  const [, iv = "", tag = "", data = ""] = sealed.split(".");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(data, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function refusal(promise: Promise<unknown>): Promise<SealError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  if (!(error instanceof SealError)) throw new Error(`expected a SealError, got ${String(error)}`);
  return error;
}

afterEach(() => vi.restoreAllMocks());

describe("createSealer", () => {
  const vault = createSealer({ current: "v1", keys: { v1: KEY } });

  it("seals to <id>.<iv>.<tag>.<ciphertext> and opens it again", async () => {
    const sealed = await vault.seal("xoxb-token çã 🔑");
    expect(sealed).toMatch(/^v1\.[\w-]{16}\.[\w-]{22}\.[\w-]+$/);
    expect(await vault.open(sealed)).toBe("xoxb-token çã 🔑");
    expect(await vault.seal("xoxb-token çã 🔑")).not.toBe(sealed);
  });

  it("seals and opens an empty string", async () => {
    const sealed = await vault.seal("");
    expect(sealed).toMatch(/\.$/);
    expect(await vault.open(sealed)).toBe("");
  });

  it("opens what the fleet's node:crypto copies wrote, and they open what it writes", async () => {
    expect(await vault.open(donorSeal(RAW, "imap-password"))).toBe("imap-password");
    expect(donorOpen(RAW, await vault.seal("imap-password"))).toBe("imap-password");
    expect(donorOpen(RAW, await vault.seal(""))).toBe("");
  });

  it("refuses a tag cut to 4 bytes, which Node alone would have opened", async () => {
    const [id, iv, tag = "", data] = (await vault.seal("token")).split(".");
    const cut = [id, iv, Buffer.from(tag, "base64url").subarray(0, 4).toString("base64url"), data];
    expect((await refusal(vault.open(cut.join(".")))).reason).toBe("malformed");
  });

  it("names both causes when a value does not open", async () => {
    const sealed = await vault.seal("token");
    const [id, iv, tag, data = ""] = sealed.split(".");
    const bytes = Buffer.from(data, "base64url");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    const changed = [id, iv, tag, bytes.toString("base64url")].join(".");
    const error = await refusal(vault.open(changed));
    expect(error.reason).toBe("did-not-open");
    expect(error.message).toContain('The key "v1" on this process is not the one that sealed it');
    expect(error.message).toContain("or the stored value was changed");

    const stranger = createSealer({ current: "v1", keys: { v1: OTHER } });
    expect((await refusal(stranger.open(sealed))).reason).toBe("did-not-open");
  });

  it("says which key it lacks, and never finds one on Object's prototype", async () => {
    const [, ...rest] = (await vault.seal("token")).split(".");
    for (const id of ["v9", "constructor"]) {
      const error = await refusal(vault.open([id, ...rest].join(".")));
      expect(error.reason).toBe("unknown-key");
      expect(error.message).toContain(`"${id}"`);
    }
  });

  it("refuses what is not a sealed value", async () => {
    const sealed = await vault.seal("token");
    const [id, iv = "", ...rest] = sealed.split(".");
    const shortIv = [
      id,
      Buffer.from(iv, "base64url").subarray(0, 8).toString("base64url"),
      ...rest,
    ];
    for (const value of [
      shortIv.join("."),
      "plain text",
      "aXY=:dGFn:Y3Q=", // a colon-separated format from another copy
      `${sealed}.AAAA`, // a fifth part that decodes, so only the count refuses it
      sealed.replace(/^v1\./, "V1."),
      sealed.replace(/\.[\w-]{16}\./, ".@@@@."),
    ])
      expect((await refusal(vault.open(value))).reason).toBe("malformed");
  });

  it("rotates: an old value still opens, and a new one is sealed with the new key", async () => {
    const sealedBefore = await vault.seal("token");
    const rotated = createSealer({ current: "v2", keys: { v1: KEY, v2: OTHER } });
    expect(await rotated.open(sealedBefore)).toBe("token");
    const sealedAfter = await rotated.seal("token");
    expect(sealedAfter.startsWith("v2.")).toBe(true);
    expect(donorOpen(Buffer.from(OTHER, "base64"), sealedAfter)).toBe("token");
  });

  it("imports each key once, however many values it handles", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");
    const fresh = createSealer({ current: "v1", keys: { v1: KEY } });
    const sealed = await Promise.all([fresh.seal("a"), fresh.seal("b"), fresh.seal("c")]);
    await Promise.all(sealed.map((value) => fresh.open(value)));
    expect(importKey).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad key at creation, and keeps the key out of the message", async () => {
    const short = Buffer.alloc(24, 1).toString("base64");
    expect(() => createSealer({ current: "v1", keys: { v1: short } })).toThrow(
      'The seal key "v1" must be 32 bytes in base64 and is 24. Make one with `openssl rand -base64 32`.',
    );
    expect(() => createSealer({ current: "v1", keys: { v1: "x" } })).toThrow("and is not base64");
    expect(() => createSealer({ current: "v1", keys: { v1: "" } })).toThrow("and is 0");
    expect(() => createSealer({ current: "v2", keys: { v1: KEY } })).toThrow(
      'The current seal key "v2" is not one of the keys given',
    );
    expect(() => createSealer({ current: "v.1", keys: { "v.1": KEY } })).toThrow(
      "lowercase letters and digits",
    );
    const hmac = await crypto.subtle.importKey(
      "raw",
      new Uint8Array(RAW),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    expect(() => createSealer({ current: "v1", keys: { v1: hmac } })).toThrow("not AES-GCM");
    const message = (() => {
      try {
        createSealer({ current: "v1", keys: { v1: short } });
        return "did not throw";
      } catch (error) {
        return String(error);
      }
    })();
    expect(message).toContain("must be 32 bytes");
    expect(message).not.toContain(short);
  });
});
