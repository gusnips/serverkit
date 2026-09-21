/**
 * The README's examples, compiled and run.
 *
 * A snippet nobody executes rots quietly, and this one is the first thing an adopter copies.
 * Every literal below is what the README prints beside the call.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createAppError, createErrorResponse, createLogger, ok, paginated } from "./index.ts";
import {
  assertEveryRouteGuarded,
  errorBoundary,
  errorHandler,
  guard,
  notFoundHandler,
  ok as okRoute,
  requestLogger,
  underAny,
} from "./hono/index.ts";
import type { RequestVariables } from "./hono/index.ts";

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

  it("answers the metered read the way the adapter snippet writes it", async () => {
    const profile = { handle: "nasa" };
    const app = new Hono().get("/lookup", (c) =>
      okRoute(c, profile, 200, { creditsCharged: 1, cache: "hit" }),
    );
    const res = await app.request("/lookup");
    expect(await res.json()).toEqual({
      data: profile,
      meta: { creditsCharged: 1, cache: "hit" },
    });
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

  it("logs the raw error and keeps the vendor's own input out of the line", async () => {
    // The README says to pass the error itself, and says the allow-list covers the cause chain
    // including a link that is not an Error. Both are one call here, because an adopter copies
    // the line and gets both or neither.
    const lines: string[] = [];
    const logger = createLogger({ write: (line) => lines.push(line) });
    const rejected = { message: "invalid signature", code: "PGRST301", payload: "the whole body" };

    logger.error("charge failed", {
      orderId: "ord_1",
      error: new Error("invalid signature", { cause: rejected }),
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("the whole body");
    const entry = JSON.parse(String(lines[0])) as { error: { cause: unknown; stack: string } };
    expect(entry.error.cause).toEqual({ message: "invalid signature", code: "PGRST301" });
    expect(entry.error.stack).toContain("Error: invalid signature");
  });

  it("mounts the four Hono pieces in the order the snippet mounts them", async () => {
    // Mounted exactly as the README prints it, then made to throw a NON-Error — which is the
    // reason the README calls errorBoundary not optional. Without it Hono never reaches onError
    // and the request ends with no answer at all.
    const logger = createLogger({ level: "silent" });
    const app = new Hono<{ Variables: RequestVariables<ErrorCode> }>();
    app.use(requestLogger({ logger }));
    app.use(errorBoundary);
    app.onError(errorHandler({ errorResponse, logger }));
    app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))));
    // A rejection with a plain object, which is the case the boundary exists for.
    app.get("/boom", () => Promise.reject({ code: "PGRST301", payload: "the whole body" }));

    const boom = await app.request("/boom");
    const missing = await app.request("/nope");

    expect(boom.status).toBe(500);
    expect(await boom.text()).not.toContain("the whole body");
    expect(boom.headers.get("X-Request-ID")).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({
      error: { code: "NOT_FOUND", message: "Route not found" },
    });
  });

  it("fails the guard check on the route the README says it names", () => {
    // The snippet's whole claim: the matcher is asked, so a `use` registered AFTER its route is
    // reported even though the pattern list would look complete.
    const requireUser = guard(async (_c, next) => next());
    const app = new Hono();
    app.get("/public/status", (c) => c.text("ok"));
    app.get("/private/thing", (c) => c.text("secret"));
    app.use("/private/*", requireUser); // too late: registered after the route it guards

    expect(() => assertEveryRouteGuarded(app, { isPublic: underAny(["/public"]) })).toThrow(
      /\/private\/thing/,
    );
  });
});
