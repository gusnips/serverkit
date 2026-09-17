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
import { type AppErrorOptions, createAppError } from "./errors.ts";

const ERROR_STATUS = {
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  QUOTA_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

type MessageKey = "serverErrors.notFound" | "serverErrors.rateLimit";

const appError = createAppError<typeof ERROR_STATUS, MessageKey>(ERROR_STATUS);
const spent = { details: { scope: "month" } };

// Annotated, not inferred: a code narrowed off a lookup table or a switch has a UNION type,
// which is the shape the rule used to lose.
const mixedCode: "NOT_FOUND" | "RATE_LIMIT_EXCEEDED" = "RATE_LIMIT_EXCEEDED";
const safeCodes: "NOT_FOUND" | "INTERNAL_ERROR" = "NOT_FOUND";
const fromConfig: number = 429;

describe("a 429 states its own wait", () => {
  it("reads the status off the map, and keeps the wait", () => {
    const err = appError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfterSecs: 30 });
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSecs).toBe(30);
    // The two honest answers, and only these two: a number, or a deliberate `null`.
    const durable = appError("QUOTA_EXCEEDED", "Wait for a job to finish", {
      retryAfterSecs: null,
    });
    expect(durable.retryAfterSecs).toBeNull();
    // A union whose status set includes 429 owes the wait too, and one that cannot be a 429
    // does not. Both directions, because only the pair proves the tuple wrappers.
    expect(appError(mixedCode, "slow", { retryAfterSecs: 5 }).message).toBe("slow");
    expect(appError(safeCodes, "gone").message).toBe("gone");
    // Any status may state a wait voluntarily — a 503 that knows its own expiry, say. Only the
    // OBLIGATION is 429-only.
    const configured = appError("INTERNAL_ERROR", "Not configured here", { retryAfterSecs: null });
    expect(configured.retryAfterSecs).toBeNull();
    expect(appError("NOT_FOUND", "Workspace not found").statusCode).toBe(404);
    expect(appError("INTERNAL_ERROR", "boom").statusCode).toBe(500);
  });
});

/** Never called. Every line here is an assertion about what does not compile. */
function refusals(): void {
  // @ts-expect-error — RATE_LIMIT_EXCEEDED maps to 429, so it has to say how it clears:
  // a number of seconds, or `null` for a refusal waiting cannot fix.
  appError("RATE_LIMIT_EXCEEDED", "Too many requests");
  // @ts-expect-error — options are there, the wait is not.
  appError("QUOTA_EXCEEDED", "Spent", spent);
  // @ts-expect-error — "TEAPOT" is not in the map.
  appError("TEAPOT", "no");
  // @ts-expect-error — "serverErrors.typo" is not a MessageKey.
  appError("NOT_FOUND", "no", { messageKey: "serverErrors.typo" });

  // The three ways a forgotten argument could have passed for a deliberate `null`. The second
  // is the one that matters: it is verbatim how three donors write their own `rateLimit`
  // factory, so it is the shape a migration reaches for first.
  // @ts-expect-error — an explicit `undefined` is not an answer.
  appError("RATE_LIMIT_EXCEEDED", "x", { retryAfterSecs: undefined });
  const forward = (message: string, opts?: AppErrorOptions<MessageKey>) =>
    // @ts-expect-error — forwarding a caller's optional opts cannot satisfy it either.
    appError("RATE_LIMIT_EXCEEDED", message, { ...opts });
  void forward;
  const partial: { retryAfterSecs?: number } = {};
  // @ts-expect-error — nor can spreading an object whose wait is optional.
  appError("RATE_LIMIT_EXCEEDED", "x", { ...partial });

  // A code narrowed to a UNION used to drop the obligation: the conditional distributed, one
  // arm had the options optional, and an empty argument list satisfied it. That is the shape a
  // code read off a lookup table or a switch actually has — the hardest one to eyeball.
  // @ts-expect-error — the union's status set includes 429, so the wait is still owed.
  appError(mixedCode, "slow");

  const widened: Record<string, number> = { RATE_LIMIT_EXCEEDED: 429 };
  // @ts-expect-error — without `as const` every value is `number`, so the rule above would
  // compile away silently. Refusing the map is the loud version.
  createAppError(widened);

  // The realistic way a map widens: ONE status read from config. `404 | number` absorbs to
  // `number`, and the whole map loses its literals.
  const half = { NOT_FOUND: 404, RATE_LIMIT_EXCEEDED: fromConfig } as const;
  // @ts-expect-error — half-widened is widened.
  createAppError<typeof half>(half);
}
void refusals;
