import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createSealer } from "../seal.ts";
import { scryptSealKey } from "./seal-key.ts";

const PASSPHRASE = "a passphrase from the environment, long enough";
const SALT = "acme-credentials-v1";

describe("scryptSealKey", () => {
  it("opens rows sealed under scryptSync, and writes rows that code still opens", async () => {
    // The writer the scrypt copies in the fleet run: the key derived with Node's defaults.
    const donorKey = scryptSync(PASSPHRASE, SALT, 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", donorKey, iv);
    const data = Buffer.concat([cipher.update("oauth-refresh-token", "utf8"), cipher.final()]);
    const stored = ["v1", iv, cipher.getAuthTag(), data]
      .map((part) => (typeof part === "string" ? part : part.toString("base64url")))
      .join(".");

    const vault = createSealer({
      current: "v1",
      keys: { v1: await scryptSealKey(PASSPHRASE, SALT) },
    });
    expect(await vault.open(stored)).toBe("oauth-refresh-token");

    const [, ivOut = "", tagOut = "", dataOut = ""] = (await vault.seal("new-token")).split(".");
    const decipher = createDecipheriv("aes-256-gcm", donorKey, Buffer.from(ivOut, "base64url"));
    decipher.setAuthTag(Buffer.from(tagOut, "base64url"));
    const opened = Buffer.concat([
      decipher.update(Buffer.from(dataOut, "base64url")),
      decipher.final(),
    ]);
    expect(opened.toString("utf8")).toBe("new-token");
  });

  it("derives a different key from a different salt, and refuses an empty passphrase", async () => {
    const one = createSealer({
      current: "v1",
      keys: { v1: await scryptSealKey(PASSPHRASE, SALT) },
    });
    const two = createSealer({
      current: "v1",
      keys: { v1: await scryptSealKey(PASSPHRASE, `${SALT}x`) },
    });
    await expect(two.open(await one.seal("token"))).rejects.toMatchObject({
      reason: "did-not-open",
    });
    await expect(scryptSealKey("", SALT)).rejects.toThrow("is empty");
  });
});
