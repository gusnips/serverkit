import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signToken, verifyToken } from "./token.ts";

const SECRET = "sb_secret_a-service-key-the-deployment-already-holds";
const PURPOSE = "acme:marketing-email-unsubscribe:v1";
const NOW = 1_700_000_000_000;

/** How five backends in the fleet sign the unsubscribe links in mail already sent. */
function donorToken(userId: string): string {
  const payload = Buffer.from(userId).toString("base64url");
  const key = createHmac("sha256", SECRET).update(PURPOSE).digest();
  return `${payload}.${createHmac("sha256", key).update(payload).digest("base64url")}`;
}

const common = { secret: SECRET, purpose: PURPOSE, now: NOW };

describe("signToken and verifyToken", () => {
  it("matches the unsubscribe links already in people's mail, byte for byte", async () => {
    expect(await signToken({ ...common, payload: "user_42" })).toBe(donorToken("user_42"));
    expect(await verifyToken({ ...common, token: donorToken("user_42") })).toEqual({
      ok: true,
      payload: "user_42",
      expiresAt: null,
    });
  });

  it("expires a token with a ttl, and says so only once the signature is ours", async () => {
    const token = await signToken({ ...common, payload: "state", ttlSecs: 600 });
    expect(token).toMatch(/^c3RhdGU\.1700000600\.[\w-]{43}$/);
    expect(await verifyToken({ ...common, token })).toEqual({
      ok: true,
      payload: "state",
      expiresAt: 1_700_000_600_000,
    });
    expect(await verifyToken({ ...common, token, now: 1_700_000_600_000 })).toMatchObject({
      ok: true,
    });
    expect(await verifyToken({ ...common, token, now: 1_700_000_600_001 })).toEqual({
      ok: false,
      reason: "expired",
    });
    // A forged token past its expiry reads as forged, not expired: "expired" means we signed it.
    const forged = token.replace(/.$/, (last) => (last === "A" ? "B" : "A"));
    expect(await verifyToken({ ...common, token: forged, now: NOW + 3_600_000 })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("cannot have its expiry dropped or moved", async () => {
    const token = await signToken({ ...common, payload: "state", ttlSecs: 600 });
    const [payload, expiry, signature] = token.split(".");
    for (const edited of [
      `${payload}.${signature}`,
      `${payload}.${Number(expiry) + 86_400}.${signature}`,
    ])
      expect(await verifyToken({ ...common, token: edited })).toEqual({
        ok: false,
        reason: "bad-signature",
      });
  });

  it("never verifies a token made for another purpose or under another secret", async () => {
    const token = await signToken({ ...common, payload: "user_42" });
    expect(await verifyToken({ ...common, purpose: "oauth-state", token })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(await verifyToken({ ...common, secret: `${SECRET}x`, token })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    const other = Buffer.from("user_43").toString("base64url");
    expect(await verifyToken({ ...common, token: token.replace(/^[^.]+/, other) })).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("refuses anything but base64url, digits and dots before checking a signature", async () => {
    const signature = "A".repeat(43);
    for (const token of [
      "",
      "user_42",
      `.${signature}`,
      `dXNlcg.${signature}=`,
      `dXNlcg.${signature}A`,
      `dXNlcg==.${signature}`,
      `<b>.${signature}`,
      `dXNlcg.12x.${signature}`,
      ` dXNlcg.${signature}`,
    ])
      expect(await verifyToken({ ...common, token })).toEqual({ ok: false, reason: "malformed" });
  });

  it("carries JSON and any text", async () => {
    const data = { provider: "google", next: "/configurações", n: 1 };
    const token = await signToken({ ...common, payload: JSON.stringify(data), ttlSecs: 60 });
    const verdict = await verifyToken({ ...common, token });
    expect(verdict.ok && JSON.parse(verdict.payload)).toEqual(data);
  });

  it("refuses to sign what it could not verify", async () => {
    await expect(signToken({ ...common, payload: "" })).rejects.toThrow(
      "payload must not be empty",
    );
    for (const ttlSecs of [0, -1, 1.5])
      await expect(signToken({ ...common, payload: "x", ttlSecs })).rejects.toThrow(
        "whole number of seconds above 0",
      );
    await expect(signToken({ ...common, purpose: "", payload: "x" })).rejects.toThrow(
      "purpose must not be empty",
    );
    await expect(signToken({ ...common, secret: "", payload: "x" })).rejects.toThrow(
      "must not be empty",
    );
  });
});
