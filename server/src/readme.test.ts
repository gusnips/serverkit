/**
 * The README's examples, compiled and run.
 *
 * A snippet nobody executes rots quietly, and this one is the first thing an adopter copies.
 * Every literal below is what the README prints beside the call.
 */
import { describe, expect, it } from "vitest";
import { createAppError, createErrorResponse, ok, paginated } from "./index.ts";

type ErrorCode =
  "VALIDATION_ERROR" | "UNAUTHORIZED" | "NOT_FOUND" | "RATE_LIMIT_EXCEEDED" | "INTERNAL_ERROR";
type MessageKey = "serverErrors.notFound";

const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ErrorCode, number>;

const appError = createAppError<typeof ERROR_STATUS, MessageKey>(ERROR_STATUS);

const errors = {
  notFound: (what = "Resource") => appError("NOT_FOUND", `${what} not found`),
  rateLimit: (retryAfterSecs: number) =>
    appError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfterSecs }),
};

const errorResponse = createErrorResponse<ErrorCode, MessageKey>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
});

describe("the README", () => {
  it("prints what ok() returns", () => {
    expect(ok({ id: 1 })).toEqual({ status: 200, body: { data: { id: 1 } } });
  });

  it("prints what paginated() returns", () => {
    const rows = [1, 2];
    expect(paginated(rows, { total: 128, limit: 20, offset: 100 })).toEqual({
      status: 200,
      body: { data: rows, meta: { total: 128, limit: 20, offset: 100, hasMore: true } },
    });
  });

  it("throws and answers the way the two snippets say", () => {
    expect(errorResponse(errors.notFound("Workspace"))).toEqual({
      status: 404,
      body: { error: { code: "NOT_FOUND", message: "Workspace not found" } },
      headers: {},
      kind: "client",
    });
  });

  it("puts a stated wait in the header and in details, from one value", () => {
    const answer = errorResponse(errors.rateLimit(45));
    expect(answer.headers["Retry-After"]).toBe("45");
    expect(answer.body.error.details).toEqual({ retryAfterSecs: 45 });
  });
});
