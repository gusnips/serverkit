import {
  AuthApiError,
  AuthRetryableFetchError,
  isAuthRetryableFetchError,
} from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { isAuthOutage } from "./index.ts";

describe("isAuthOutage", () => {
  it("is false for auth actually refusing the token, which is the only thing that ends a session", () => {
    expect(isAuthOutage(new AuthApiError("invalid JWT", 401, "bad_jwt"))).toBe(false);
    expect(isAuthOutage(new AuthApiError("forbidden", 403, "not_admin"))).toBe(false);
    // `getUser` answers `{ data, error: null }` on success, and the door asks anyway.
    expect(isAuthOutage(null)).toBe(false);
  });

  it("is true for auth failing to answer at all", () => {
    // Status 0 — the fetch never landed. This is the SDK's own class for that.
    expect(isAuthOutage(new AuthRetryableFetchError("fetch failed", 0))).toBe(true);
  });

  it("the two clauses divide exactly where the SDK's own class assignment divides", () => {
    // auth-js reads `NETWORK_ERROR_CODES` in `lib/fetch.js` and builds an
    // `AuthRetryableFetchError` for a listed status, an `AuthApiError` for every other. So the
    // vendor's predicate owns the listed statuses and our status clause owns the holes, and
    // neither alone covers a 5xx.
    //
    // Building an `AuthApiError` with a 502 on it to stand for "GoTrue answered 502" is the
    // trap: the SDK never produces that shape, so a test written that way passes for a reason
    // its comment gets wrong. That exact mistake shipped in this fleet and had to be corrected.
    const listed = new AuthRetryableFetchError("bad gateway", 502);
    const hole = new AuthApiError("proxy said 507", 507, undefined);

    expect(isAuthRetryableFetchError(listed)).toBe(true);
    expect(isAuthRetryableFetchError(hole)).toBe(false);
    expect(isAuthOutage(listed)).toBe(true);
    expect(isAuthOutage(hole)).toBe(true);
  });

  it("catches every hole in the vendor's list — the reason the second clause exists", () => {
    // THE load-bearing assertion, written as a CLAIM rather than as a version number: at auth-js
    // 2.116.0 the list is [500-504, 520-530], so 505-519 and 531+ are holes, and they have been
    // holes at every version ever shipped. This goes red the day the vendor switches to a range,
    // which is the day the comment on `isAuthOutage` needs rewriting. A version sentence nothing
    // executes is exactly how ten copies of this predicate went stale across the fleet.
    for (const status of [505, 507, 511, 519, 531, 599]) {
      expect(isAuthRetryableFetchError(new AuthApiError("x", status, undefined))).toBe(false);
      expect(isAuthOutage(new AuthApiError("x", status, undefined))).toBe(true);
    }
  });

  it("takes unknown, because two of the three call sites hold something that is not an AuthError", () => {
    // The `catch` around a user lookup holds whatever was thrown; a driver's TypeError is not an
    // auth outage and must not be reported as one.
    expect(isAuthOutage(new TypeError("cannot read properties of undefined"))).toBe(false);
    expect(isAuthOutage(undefined)).toBe(false);
    expect(isAuthOutage(42)).toBe(false);
    expect(isAuthOutage("boom")).toBe(false);
    expect(isAuthOutage({})).toBe(false);
    // A plain object carrying a 5xx IS an outage: a hand-rolled fetch wrapper in front of GoTrue
    // throws exactly this shape, and the status is the whole question.
    expect(isAuthOutage({ status: 503 })).toBe(true);
    expect(isAuthOutage({ status: "503" })).toBe(false);
  });
});
