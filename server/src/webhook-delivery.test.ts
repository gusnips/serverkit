import { describe, expect, it, vi } from "vitest";
import { nextDeliveryStep } from "./webhook-delivery.ts";

const answer = (status: number, headers: Record<string, string> = {}) => ({
  status,
  headers: new Headers(headers),
});

describe("nextDeliveryStep", () => {
  it("calls every 2xx delivered", () => {
    for (const status of [200, 201, 202, 204, 299])
      expect(nextDeliveryStep(answer(status), 1)).toEqual({ outcome: "delivered" });
  });

  it("stops at a redirect, which a webhook never follows", () => {
    for (const status of [0, 301, 302, 307, 308])
      expect(nextDeliveryStep(answer(status), 1)).toEqual({
        outcome: "failed",
        reason: "redirected",
      });
  });

  it("stops at a 4xx, even with attempts left and a Retry-After", () => {
    for (const status of [400, 401, 403, 404, 409, 410, 413, 422])
      expect(nextDeliveryStep(answer(status, { "retry-after": "5" }), 1)).toEqual({
        outcome: "failed",
        reason: "refused",
      });
  });

  it("retries 408, 425, 429, every 5xx, and no answer at all", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504, 599])
      expect(nextDeliveryStep(answer(status), 1)).toEqual({ outcome: "retry", afterSecs: 30 });
    expect(nextDeliveryStep(null, 1)).toEqual({ outcome: "retry", afterSecs: 30 });
  });

  it("doubles the wait from 30 seconds and stops after the fifth attempt", () => {
    const waits = [1, 2, 3, 4].map((n) => nextDeliveryStep(null, n));
    expect(waits).toEqual([30, 60, 120, 240].map((afterSecs) => ({ outcome: "retry", afterSecs })));
    expect(nextDeliveryStep(null, 5)).toEqual({ outcome: "failed", reason: "exhausted" });
    expect(nextDeliveryStep(answer(503), 5)).toEqual({ outcome: "failed", reason: "exhausted" });
  });

  it("takes the policy's attempts, base and ceiling", () => {
    const policy = { attempts: 8, baseSecs: 60, maxWaitSecs: 900 };
    expect([1, 4, 5, 7].map((n) => nextDeliveryStep(null, n, policy))).toEqual([
      { outcome: "retry", afterSecs: 60 },
      { outcome: "retry", afterSecs: 480 },
      { outcome: "retry", afterSecs: 900 },
      { outcome: "retry", afterSecs: 900 },
    ]);
    expect(nextDeliveryStep(null, 8, policy)).toEqual({ outcome: "failed", reason: "exhausted" });
  });

  it("waits as long as Retry-After says, in seconds or as a date, and never less than the ladder", () => {
    expect(nextDeliveryStep(answer(429, { "retry-after": "90" }), 1)).toEqual({
      outcome: "retry",
      afterSecs: 90,
    });
    expect(nextDeliveryStep(answer(503, { "retry-after": "5" }), 2)).toEqual({
      outcome: "retry",
      afterSecs: 60,
    });
    // Half a second past the minute, so rounding down would come back before the date.
    vi.useFakeTimers({ now: Date.parse("2026-01-01T00:00:00.500Z") });
    try {
      const step = nextDeliveryStep(
        answer(503, { "retry-after": "Thu, 01 Jan 2026 00:02:00 GMT" }),
        1,
      );
      expect(step).toEqual({ outcome: "retry", afterSecs: 120 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps a long Retry-After at the ceiling instead of giving up", () => {
    expect(nextDeliveryStep(answer(503, { "retry-after": "10800" }), 1)).toEqual({
      outcome: "retry",
      afterSecs: 3600,
    });
  });

  it("ignores a Retry-After it cannot read, and one in the past", () => {
    for (const value of ["-5", "soon", "", "1.5", new Date(Date.now() - 60_000).toUTCString()])
      expect(nextDeliveryStep(answer(429, { "retry-after": value }), 1)).toEqual({
        outcome: "retry",
        afterSecs: 30,
      });
  });

  it("refuses an attempt number that does not count from 1", () => {
    for (const attempt of [0, -1, 1.5, Number.NaN])
      expect(() => nextDeliveryStep(null, attempt)).toThrow("attempt counts from 1");
  });
});
