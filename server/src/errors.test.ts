import { describe, expect, it } from "vitest";
import { AppError, toMessage } from "./errors.ts";

describe("AppError.toJSON", () => {
  it("omits every optional field that was not set", () => {
    const body = new AppError(404, "NOT_FOUND", "Workspace not found").toJSON();
    expect(body).toEqual({ error: { code: "NOT_FOUND", message: "Workspace not found" } });
  });

  it("carries messageKey, params and details when they are set", () => {
    const body = new AppError(402, "PLAN_GATE", "Webhooks are not in your plan", {
      messageKey: "serverErrors.planGate",
      params: { gate: "webhooks" },
      details: { gate: "webhooks", upgradeTo: "starter" },
    }).toJSON();
    expect(body.error.messageKey).toBe("serverErrors.planGate");
    expect(body.error.params).toEqual({ gate: "webhooks" });
    expect(body.error.details).toEqual({ gate: "webhooks", upgradeTo: "starter" });
  });
});

describe("a stated wait rides in details as well as the header", () => {
  it("folds retryAfterSecs into an object details", () => {
    const body = new AppError(429, "RATE_LIMIT_EXCEEDED", "Too many requests", {
      details: { limit: 60 },
      retryAfterSecs: 30,
    }).toJSON();
    expect(body.error.details).toEqual({ limit: 60, retryAfterSecs: 30 });
  });

  it("folds it into an absent details", () => {
    const body = new AppError(429, "RATE_LIMIT_EXCEEDED", "Too many requests", {
      retryAfterSecs: 30,
    }).toJSON();
    expect(body.error.details).toEqual({ retryAfterSecs: 30 });
  });

  it("hands an ARRAY details back untouched", () => {
    const issues = [{ path: ["url"], code: "invalid_string" }];
    const body = new AppError(400, "VALIDATION_ERROR", "Invalid request", {
      details: issues,
      retryAfterSecs: 5,
    }).toJSON();
    expect(body.error.details).toEqual(issues);
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it("hands a STRING details back untouched", () => {
    const body = new AppError(429, "QUOTA_EXCEEDED", "Spent", {
      details: "month",
      retryAfterSecs: 5,
    }).toJSON();
    expect(body.error.details).toBe("month");
  });
});

describe("toMessage", () => {
  it("reads an Error's message", () => {
    expect(toMessage(new Error("boom"))).toBe("boom");
  });

  it("reads a string message off a plain object", () => {
    expect(toMessage({ code: "23505", message: "duplicate key value" })).toBe(
      "duplicate key value",
    );
  });

  it("returns a string as itself", () => {
    expect(toMessage("just a string")).toBe("just a string");
  });

  it("serializes a plain object with no message rather than flattening it", () => {
    const out = toMessage({ code: "PGRST205", hint: "run the migration" });
    expect(out).not.toBe("[object Object]");
    expect(out).toContain("PGRST205");
    expect(out).toContain("run the migration");
  });

  it("survives a circular object", () => {
    const cycle: Record<string, unknown> = { code: "E_CYCLE" };
    cycle.self = cycle;
    expect(() => toMessage(cycle)).not.toThrow();
    expect(toMessage(cycle)).toContain("E_CYCLE");
  });

  it("falls back to String() for a primitive", () => {
    expect(toMessage(null)).toBe("null");
    expect(toMessage(42)).toBe("42");
  });
});
