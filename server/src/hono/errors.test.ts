import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { AppError, createAppError, createErrorResponse, createLogger } from "../index.ts";
import { errorBoundary, errorHandler, notFoundHandler } from "./errors.ts";
import { requestLogger, type RequestVariables } from "./request-logger.ts";

type ErrorCode = "NOT_FOUND" | "RATE_LIMIT_EXCEEDED" | "UNAVAILABLE" | "INTERNAL_ERROR" | "ODD";

const appError = createAppError({
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const);

const errorResponse = createErrorResponse<ErrorCode, string>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "INTERNAL_ERROR", message: "unused here" },
});

function setup({ boundary = true } = {}) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const onUnexpected = vi.fn();
  const app = new Hono<{ Variables: RequestVariables<ErrorCode> }>();
  app.use(requestLogger({ logger }));
  if (boundary) app.use(errorBoundary);
  app.onError(errorHandler({ errorResponse, logger, onUnexpected }));
  app.notFound(notFoundHandler(errorResponse(appError("NOT_FOUND", "Route not found"))));
  return { app, lines, onUnexpected };
}

describe("errorBoundary", () => {
  const rejection = { code: "PGRST116", message: "no rows returned" };

  it("turns a thrown plain object into an answer, where Hono alone answers nothing", async () => {
    const bare = setup({ boundary: false });
    bare.app.get("/rows", () => {
      throw rejection;
    });
    await expect(bare.app.request("/rows")).rejects.toBe(rejection);

    const { app } = setup();
    app.get("/rows", () => {
      throw rejection;
    });
    const res = await app.request("/rows");

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
    });
  });

  it("keeps the original as the cause, and its message as the message", async () => {
    const { app, lines } = setup();
    app.get("/rows", () => {
      throw rejection;
    });

    await app.request("/rows");

    const failed = lines.find((line) => line.message === "request failed");
    expect(failed?.error).toMatchObject({ message: "no rows returned", cause: rejection });
  });

  it("logs what was thrown through the same allow-list as an Error, failing row and all", async () => {
    // What a PostgREST client rejects with for a CHECK violation. Its `details` is the whole
    // failing row, which the allow-list replaces on an Error and let through on a plain cause.
    const { app, lines } = setup();
    app.post("/cards", () => {
      throw {
        code: "23514",
        message: 'new row for relation "cards" violates check constraint "cards_number_check"',
        details: "Failing row contains (someone@example.com, 4242424242424242).",
        hint: null,
      };
    });

    await app.request("/cards", { method: "POST" });

    const failed = lines.find((line) => line.message === "request failed");
    expect(failed?.error).toMatchObject({ cause: { code: "23514" } });
    expect(JSON.stringify(lines)).not.toMatch(/4242|someone@/);
  });

  it("names a thrown object with no message by its code, and leaves the rest to the cause", async () => {
    const { app, lines } = setup();
    app.get("/cards", () => {
      throw { code: "PGRST205", hint: "run the migration", query: "where number = '4242'" };
    });

    await app.request("/cards");

    const failed = lines.find((line) => line.message === "request failed");
    expect(failed?.error).toMatchObject({
      message: "A thrown object with no message (code PGRST205)",
      cause: { code: "PGRST205", hint: "run the migration" },
    });
    expect(JSON.stringify(lines)).not.toContain("4242");
  });

  it("hands a real Error through as the same instance", async () => {
    const thrown = new TypeError("x is undefined");
    const { app, onUnexpected } = setup();
    app.get("/", () => {
      throw thrown;
    });

    await app.request("/");

    expect(onUnexpected.mock.calls[0]![0]).toBe(thrown);
  });
});

describe("errorHandler", () => {
  it("answers a refusal with its status, body and headers, and names it on the request line", async () => {
    const { app, lines, onUnexpected } = setup();
    app.get("/send", () => {
      throw appError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfterSecs: 30 });
    });

    const res = await app.request("/send");

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.json()).toMatchObject({ error: { code: "RATE_LIMIT_EXCEEDED" } });
    expect(lines).toEqual([
      expect.objectContaining({
        message: "request",
        status: 429,
        errorCode: "RATE_LIMIT_EXCEEDED",
      }),
    ]);
    expect(onUnexpected).not.toHaveBeenCalled();
  });

  it("logs a 5xx it was handed on purpose, without calling it unexpected", async () => {
    const { app, lines, onUnexpected } = setup();
    app.get("/", () => {
      throw appError("UNAVAILABLE", "The database is unreachable");
    });

    const res = await app.request("/");

    expect(res.status).toBe(503);
    expect(lines[0]).toMatchObject({ level: "error", message: "request failed", kind: "server" });
    expect(onUnexpected).not.toHaveBeenCalled();
  });

  it("logs an escaped throw with its stack, alerts on it, and answers the generic 500", async () => {
    const { app, lines, onUnexpected } = setup();
    app.get("/", () => {
      throw new TypeError("x is undefined");
    });

    const res = await app.request("/");

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(lines[0]).toMatchObject({ level: "error", kind: "unexpected" });
    expect(lines[0]!.error).toMatchObject({ name: "TypeError", message: "x is undefined" });
    expect(String((lines[0]!.error as { stack: string }).stack)).toContain("TypeError");
    expect(lines[1]).toMatchObject({
      message: "request",
      status: 500,
      errorCode: "INTERNAL_ERROR",
    });
    expect(onUnexpected).toHaveBeenCalledOnce();
  });

  it("carries the request id on the error answer, the same one the lines carry", async () => {
    // The browser client reads the id off this header into the error it raises, which is what
    // lets an error screen show a reference someone can quote.
    const { app, lines } = setup();
    app.get("/", () => {
      throw new TypeError("x is undefined");
    });

    const res = await app.request("/", { headers: { "X-Request-ID": "trace-1" } });

    expect(res.headers.get("X-Request-ID")).toBe("trace-1");
    expect(lines.map((line) => line.requestId)).toEqual(["trace-1", "trace-1"]);
  });

  it.each([
    ["a success", 200],
    ["one that cannot carry a body", 204],
    ["one outside HTTP", 700],
  ])("treats an error raised with %s status as the bug it is", async (_, status) => {
    // Hono hands an Error thrown out of onError back to onError, one level up. So refusing the
    // status is enough to land it in the unexpected arm, where somebody is told.
    const { app, lines, onUnexpected } = setup();
    app.get("/", () => {
      throw new AppError(status, "ODD", "a status nobody should raise");
    });

    const res = await app.request("/");

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: "INTERNAL_ERROR" } });
    expect(onUnexpected).toHaveBeenCalledOnce();
    expect(lines.find((line) => line.kind === "unexpected")?.error).toMatchObject({
      name: "RangeError",
      message: `An error answered ${status}.`,
    });
  });
});

describe("notFoundHandler", () => {
  it("answers the refusal it was given, with the request id, and names it on the request line", async () => {
    const { app, lines } = setup();

    const res = await app.request("/nothing/here");

    expect(res.status).toBe(404);
    expect(res.headers.get("X-Request-ID")).toBeTruthy();
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Route not found" } });
    expect(lines[0]).toMatchObject({ status: 404, errorCode: "NOT_FOUND" });
  });
});

describe("an app's own env", () => {
  it("takes all four pieces without a cast", async () => {
    // The shape an adopter writes: bindings, variables of its own, and `errorCode` typed to its
    // own code union rather than to `string`.
    type AppEnv = {
      Bindings: { DATABASE_URL: string };
      Variables: { requestId: string; errorCode: ErrorCode | null; userId: string };
    };
    const logger = createLogger({ level: "silent" });
    const app = new Hono<AppEnv>();
    app.use(requestLogger({ logger }));
    app.use(errorBoundary);
    app.onError(errorHandler({ errorResponse, logger, onUnexpected: (_err, c) => c.req.method }));
    app.notFound(notFoundHandler(errorResponse(appError("NOT_FOUND", "Route not found"))));
    app.get("/", (c) => c.text(c.get("requestId")));

    expect((await app.request("/")).status).toBe(200);
  });

  it("refuses an errorResponse that answers codes the app's errorCode cannot hold", () => {
    const logger = createLogger({ level: "silent" });
    const narrow = new Hono<{ Variables: RequestVariables<"NOT_FOUND"> }>();
    // @ts-expect-error — this errorResponse also answers INTERNAL_ERROR, among others.
    narrow.onError(errorHandler({ errorResponse, logger }));
  });
});
