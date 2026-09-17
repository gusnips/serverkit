/**
 * Type-level guards. Most of this file never runs: `@ts-expect-error` fails
 * `bun run typecheck` if the line under it ever starts compiling, which is the only way to
 * pin a rule whose whole value is that a call site cannot be written.
 *
 * Every guarded statement is kept SHORT on purpose. `@ts-expect-error` binds to the next
 * physical line, and the formatter decides where that is — wrap the call and the directive
 * lands on `expect(() =>` , which has no error, while the real one moves out of its reach.
 */
import { describe, expect, it } from "vitest";
import { createAppError } from "./errors.ts";

const ERROR_STATUS = {
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  QUOTA_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

type MessageKey = "serverErrors.notFound" | "serverErrors.rateLimit";

const appError = createAppError<typeof ERROR_STATUS, MessageKey>(ERROR_STATUS);
const spent = { details: { scope: "month" } };

describe("a 429 states its own wait", () => {
  it("reads the status off the map, and keeps the wait", () => {
    const err = appError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfterSecs: 30 });
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSecs).toBe(30);
    expect(appError("NOT_FOUND", "Workspace not found").statusCode).toBe(404);
    expect(appError("INTERNAL_ERROR", "boom").statusCode).toBe(500);
  });
});

/** Never called. Every line here is an assertion about what does not compile. */
function refusals(): void {
  // @ts-expect-error — RATE_LIMIT_EXCEEDED maps to 429, so a wait is required.
  appError("RATE_LIMIT_EXCEEDED", "Too many requests");
  // @ts-expect-error — options are there, the wait is not.
  appError("QUOTA_EXCEEDED", "Spent", spent);
  // @ts-expect-error — "TEAPOT" is not in the map.
  appError("TEAPOT", "no");
  // @ts-expect-error — "serverErrors.typo" is not a MessageKey.
  appError("NOT_FOUND", "no", { messageKey: "serverErrors.typo" });

  const widened: Record<string, number> = { RATE_LIMIT_EXCEEDED: 429 };
  // @ts-expect-error — without `as const` every value is `number`, so the rule above would
  // compile away silently. Refusing the map is the loud version.
  createAppError(widened);
}
void refusals;
