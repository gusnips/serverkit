import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppError, createAppError } from "./errors.ts";
import { created, createErrorResponse, noContent, ok, paginated } from "./responses.ts";

type Code =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "RATE_LIMIT_EXCEEDED"
  | "INTERNAL_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "GATEWAY_ERROR";

const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_ERROR: 502,
} as const satisfies Record<Code, number>;

const appError = createAppError<typeof ERROR_STATUS>(ERROR_STATUS);

const errorResponse = createErrorResponse<Code>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
});

describe("success helpers", () => {
  it("wraps every 2xx body in { data }", () => {
    expect(ok({ id: 1 })).toEqual({ status: 200, body: { data: { id: 1 } } });
    expect(created({ id: 1 })).toEqual({ status: 201, body: { data: { id: 1 } } });
    expect(noContent()).toEqual({ status: 204, body: null });
  });

  it("omits meta when there is none", () => {
    expect(ok({ id: 1 }).body).not.toHaveProperty("meta");
  });

  it("computes hasMore from the page it actually returned", () => {
    expect(paginated([1, 2], { total: 10, limit: 2, offset: 0 }).body.meta).toEqual({
      total: 10,
      limit: 2,
      offset: 0,
      hasMore: true,
    });
    expect(paginated([9, 10], { total: 10, limit: 2, offset: 8 }).body.meta?.hasMore).toBe(false);
    expect(paginated([], { total: 0, limit: 20, offset: 0 }).body.meta?.hasMore).toBe(false);
  });
});

describe("a validation failure is a 400 that reflects nothing back", () => {
  const schema = z
    .object({ days: z.enum(["7", "30"]), timeoutMs: z.number().max(30_000) })
    .strict();

  it("answers 400 with the path and the rule", () => {
    const parsed = schema.safeParse({ days: "90", timeoutMs: 1 });
    const answer = errorResponse(parsed.error);
    expect(answer.status).toBe(400);
    expect(answer.kind).toBe("client");
    expect(answer.body.error.code).toBe("VALIDATION_ERROR");
    expect(answer.body.error.details).toEqual([{ path: ["days"], code: "invalid_value" }]);
  });

  it("carries the BOUND a range failed against, because the bound is our published contract", () => {
    const parsed = schema.safeParse({ days: "7", timeoutMs: 999_999 });
    expect(errorResponse(parsed.error).body.error.details).toEqual([
      { path: ["timeoutMs"], code: "too_big", maximum: 30_000 },
    ]);
  });

  it("never reflects the rejected value or the keys the caller sent", () => {
    const parsed = schema.safeParse({ days: "90", timeoutMs: 1, secretGuess: "admin" });
    const details = JSON.stringify(errorResponse(parsed.error).body.error.details);
    expect(details).not.toContain("90");
    expect(details).not.toContain("secretGuess");
    expect(details).not.toContain("admin");
  });

  it("recognizes a ZodError structurally, with no zod import of its own", () => {
    const hand = {
      name: "ZodError",
      issues: [{ path: ["a"], code: "custom", received: "sekrit" }],
    };
    const answer = errorResponse(hand);
    expect(answer.status).toBe(400);
    expect(JSON.stringify(answer.body.error.details)).not.toContain("sekrit");
  });
});

describe("an AppError under 500 is answered as itself", () => {
  it("keeps the status, the code and the message", () => {
    const answer = errorResponse(appError("NOT_FOUND", "Workspace not found"));
    expect(answer).toMatchObject({
      status: 404,
      kind: "client",
      body: { error: { code: "NOT_FOUND", message: "Workspace not found" } },
    });
  });

  it("names the scheme it wants on a 401", () => {
    expect(errorResponse(appError("UNAUTHORIZED", "Sign in")).headers).toEqual({
      "WWW-Authenticate": "Bearer",
    });
  });

  it("states a wait in the header as well as in details", () => {
    const answer = errorResponse(
      appError("RATE_LIMIT_EXCEEDED", "Slow down", { retryAfterSecs: 45 }),
    );
    expect(answer.headers["Retry-After"]).toBe("45");
    expect(answer.body.error.details).toEqual({ retryAfterSecs: 45 });
  });
});

describe("the 5xx mask", () => {
  it("replaces the message of the one code that may carry internals", () => {
    const answer = errorResponse(
      appError("INTERNAL_ERROR", 'duplicate key value violates "users_email_key"'),
    );
    expect(answer.status).toBe(500);
    expect(answer.kind).toBe("server");
    expect(answer.body.error.message).toBe("Something on our side failed");
    expect(JSON.stringify(answer.body)).not.toContain("users_email_key");
  });

  it("lets an authored 5xx through, because it is what says whether to retry", () => {
    const answer = errorResponse(appError("SERVICE_UNAVAILABLE", "Metering is unavailable"));
    expect(answer.status).toBe(503);
    expect(answer.body.error.message).toBe("Metering is unavailable");
  });

  it("keeps the STATUS when it masks the message", () => {
    const all = createErrorResponse<Code>({
      internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
      validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
      maskAll: true,
    });
    const answer = all(appError("GATEWAY_ERROR", "upstream said: connection reset by peer"));
    expect(answer.status).toBe(502);
    expect(answer.body.error.message).toBe("Something on our side failed");
    expect(answer.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("lets `expose` opt an authored sentence back through maskAll", () => {
    const all = createErrorResponse<Code>({
      internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
      validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
      maskAll: true,
    });
    const err = appError("SERVICE_UNAVAILABLE", "Payments are not set up here", { expose: true });
    expect(all(err).body.error.message).toBe("Payments are not set up here");
  });

  it("drops a 5xx's details on its own knob, exposed or not", () => {
    const quiet = createErrorResponse<Code>({
      internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
      validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
      maskDetails: true,
    });
    const err = appError("SERVICE_UNAVAILABLE", "A dependency is down", {
      details: { pg: "connection refused at 10.0.0.4:5432" },
    });
    expect(quiet(err).body.error.message).toBe("A dependency is down");
    expect(quiet(err).body.error).not.toHaveProperty("details");
    expect(JSON.stringify(quiet(err))).not.toContain("10.0.0.4");
  });

  it("keeps a 5xx's details by default, because they name which dependency is down", () => {
    const err = appError("SERVICE_UNAVAILABLE", "Not ready", {
      details: { pg: "down", redis: "ok" },
    });
    expect(errorResponse(err).body.error.details).toEqual({ pg: "down", redis: "ok" });
  });

  it("leaves a 4xx's details alone whatever the mask says", () => {
    const quiet = createErrorResponse<Code>({
      internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
      validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
      maskAll: true,
      maskDetails: true,
    });
    const err = appError("NOT_FOUND", "No such plan", { details: { id: "pro" } });
    expect(quiet(err).body.error.details).toEqual({ id: "pro" });
    expect(quiet(err).body.error.message).toBe("No such plan");
  });
});

describe("a throw nobody raised on purpose", () => {
  it("answers a generic 500 and never repeats what it caught", () => {
    const answer = errorResponse(new Error("ECONNREFUSED redis://10.0.0.4:6379"));
    expect(answer.status).toBe(500);
    expect(answer.kind).toBe("unexpected");
    expect(answer.body.error.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(answer)).not.toContain("10.0.0.4");
  });

  it("does the same for a plain object a driver rejected with", () => {
    const answer = errorResponse({ code: "PGRST205", message: 'Could not find table "app.jobs"' });
    expect(answer.status).toBe(500);
    expect(answer.kind).toBe("unexpected");
    expect(JSON.stringify(answer)).not.toContain("app.jobs");
  });

  it("separates a 5xx we raised from one that escaped", () => {
    expect(errorResponse(appError("INTERNAL_ERROR", "we broke it")).kind).toBe("server");
    expect(errorResponse(new AppError(500, "INTERNAL_ERROR", "we broke it")).kind).toBe("server");
    expect(errorResponse("a string nobody expected").kind).toBe("unexpected");
  });
});
