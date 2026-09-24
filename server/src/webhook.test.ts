import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  newWebhookSecret,
  signStandardWebhook,
  signWebhook,
  verifyStandardWebhook,
  verifyWebhook,
} from "./webhook.ts";

const NOW = 1_700_000_000_000;
const T = NOW / 1000;
const SECRET = "whsec_c2lnbmluZy1zZWNyZXQtZm9yLXRlc3Rz";
const OLD_SECRET = "whsec_b2xkLXNpZ25pbmctc2VjcmV0LWZvci10ZXN0cw==";
const BODY = '{"type":"job.completed","id":"evt_1"}';

/** The formula every sender in the fleet uses today, with node:crypto. */
function donorHeader(secret: string, t: number, body: string): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}

describe("signWebhook and verifyWebhook", () => {
  it("signs what the fleet's senders sign, keyed by the whole secret", async () => {
    expect(await signWebhook({ secret: SECRET, body: BODY, now: NOW })).toBe(
      donorHeader(SECRET, T, BODY),
    );
  });

  it("accepts a delivery signed by the fleet's formula", async () => {
    const header = donorHeader(SECRET, T, BODY);
    expect(await verifyWebhook({ secrets: [SECRET], header, body: BODY, now: NOW })).toEqual({
      ok: true,
    });
  });

  it("refuses a delivery older than five minutes, however well signed", async () => {
    const header = donorHeader(SECRET, T - 30 * 86_400, BODY);
    expect(await verifyWebhook({ secrets: [SECRET], header, body: BODY, now: NOW })).toEqual({
      ok: false,
      reason: "stale",
    });
    const ahead = donorHeader(SECRET, T + 301, BODY);
    expect(await verifyWebhook({ secrets: [SECRET], header: ahead, body: BODY, now: NOW })).toEqual(
      { ok: false, reason: "stale" },
    );
    const edge = donorHeader(SECRET, T - 300, BODY);
    expect(await verifyWebhook({ secrets: [SECRET], header: edge, body: BODY, now: NOW })).toEqual({
      ok: true,
    });
  });

  it("refuses an old signature with a fresh timestamp pasted on the front", async () => {
    const old = donorHeader(SECRET, T - 3_600, BODY);
    const replayed = `t=${T},${old.split(",")[1]}`;
    const verdict = await verifyWebhook({
      secrets: [SECRET],
      header: replayed,
      body: BODY,
      now: NOW,
    });
    expect(verdict).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("tries every v1 and every secret, so a rotation needs no second code path", async () => {
    const signedByOld = donorHeader(OLD_SECRET, T, BODY);
    // In the middle, so a parser keeping only the first or only the last `v1` fails.
    const both = `t=${T},v1=${"0".repeat(64)},${signedByOld.split(",")[1]},v1=${"f".repeat(64)}`;
    const secrets = [SECRET, OLD_SECRET];
    expect(await verifyWebhook({ secrets, header: both, body: BODY, now: NOW })).toEqual({
      ok: true,
    });
  });

  it("refuses a changed body and a wrong secret", async () => {
    const header = donorHeader(SECRET, T, BODY);
    const tampered = await verifyWebhook({
      secrets: [SECRET],
      header,
      body: BODY.replace("evt_1", "evt_2"),
      now: NOW,
    });
    expect(tampered).toEqual({ ok: false, reason: "bad-signature" });
    const wrong = await verifyWebhook({ secrets: [OLD_SECRET], header, body: BODY, now: NOW });
    expect(wrong).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("says no-secret when none is set, even for a header signed with an empty key", async () => {
    const forged = donorHeader("", T, BODY);
    for (const secrets of [[], [""], [undefined, undefined]]) {
      expect(await verifyWebhook({ secrets, header: forged, body: BODY, now: NOW })).toEqual({
        ok: false,
        reason: "no-secret",
      });
    }
  });

  it("names a missing or malformed header", async () => {
    const check = (header: string | null) =>
      verifyWebhook({ secrets: [SECRET], header, body: BODY, now: NOW });
    const sig = donorHeader(SECRET, T, BODY).split(",")[1];
    expect(await check(null)).toEqual({ ok: false, reason: "missing-header" });
    expect(await check("")).toEqual({ ok: false, reason: "missing-header" });
    expect(await check(`${sig}`)).toEqual({ ok: false, reason: "malformed" });
    expect(await check(`t=${T}`)).toEqual({ ok: false, reason: "malformed" });
    expect(await check(`t=1e9,${sig}`)).toEqual({ ok: false, reason: "malformed" });
    // Two timestamps: the age would be read from one and the signature checked on the other.
    expect(await check(`t=${T - 3_600},${sig},t=${T}`)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("signStandardWebhook and verifyStandardWebhook", () => {
  // The example in Standard Webhooks' own documentation.
  const SPEC = {
    secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    body: '{"test": 2432232314}',
    now: 1_614_265_330_000,
  };

  function headersOf(signature: string, timestamp = String(SPEC.now / 1000)): Headers {
    return new Headers({
      "webhook-id": SPEC.id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    });
  }

  it("signs the spec's example to the spec's answer", async () => {
    expect(await signStandardWebhook(SPEC)).toEqual({
      "webhook-id": SPEC.id,
      "webhook-timestamp": "1614265330",
      "webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
    });
  });

  it("accepts Supabase Auth's header whether our signature comes first or second", async () => {
    const ours = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
    const other = "v1,aW52YWxpZC1idXQtd2VsbC1mb3JtZWQtc2lnbmF0dXJlPQ==";
    const verify = (signature: string, secret = SPEC.secret) =>
      verifyStandardWebhook({
        secrets: [secret],
        headers: headersOf(signature),
        body: SPEC.body,
        now: SPEC.now,
      });
    for (const header of [
      ours,
      `${ours}, ${other}`, // Supabase Auth joins with ", ", and ours first is the case that broke
      `${other}, ${ours}`,
      `${ours} ${other}`, // the spec's single space
      `${other},${ours}`,
    ])
      expect(await verify(header)).toEqual({ ok: true });
    // The secret as Supabase prints it, for GOTRUE_HOOK_*_SECRETS.
    expect(await verify(ours, `v1,${SPEC.secret}`)).toEqual({ ok: true });
    expect(await verify(other)).toEqual({ ok: false, reason: "bad-signature" });
    // An asymmetric signature is a different scheme, and never read as ours.
    expect(await verify(ours.replace("v1,", "v1a,"))).toEqual({ ok: false, reason: "malformed" });
  });

  it("refuses a call signed 30 days ago", async () => {
    const signed = await signStandardWebhook({ ...SPEC, now: SPEC.now - 30 * 86_400_000 });
    const verdict = await verifyStandardWebhook({
      secrets: [SPEC.secret],
      headers: new Headers({ ...signed }),
      body: SPEC.body,
      now: SPEC.now,
    });
    expect(verdict).toEqual({ ok: false, reason: "stale" });
  });

  it("round-trips a new secret, and the old one still verifies during a rotation", async () => {
    const [current, previous] = [newWebhookSecret(), newWebhookSecret()];
    expect(current).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(current).not.toBe(previous);
    const signed = await signStandardWebhook({ secret: previous, id: "evt_1", body: BODY });
    const verdict = await verifyStandardWebhook({
      secrets: [current, previous],
      headers: new Headers({ ...signed }),
      body: BODY,
    });
    expect(verdict).toEqual({ ok: true });
  });

  it("names what is missing, and throws on a secret that is not base64", async () => {
    const verify = (headers: Headers, secrets: (string | undefined)[] = [SPEC.secret]) =>
      verifyStandardWebhook({ secrets, headers, body: SPEC.body, now: SPEC.now });
    const signature = "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=";
    expect(await verify(headersOf(signature), [undefined, ""])).toEqual({
      ok: false,
      reason: "no-secret",
    });
    expect(await verify(new Headers({ "webhook-signature": signature }))).toEqual({
      ok: false,
      reason: "missing-header",
    });
    expect(await verify(headersOf(signature, "soon"))).toEqual({ ok: false, reason: "malformed" });
    await expect(verify(headersOf(signature), ["whsec_not base64!"])).rejects.toThrow(
      "must be base64 after `whsec_`",
    );
  });
});
