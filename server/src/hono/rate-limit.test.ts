import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppError, createErrorResponse, createLogger } from "../index.ts";
import { memoryWindowStore, type RefusedHit, type WindowStore } from "../rate-limit.ts";
import { errorHandler } from "./errors.ts";
import { rateLimit } from "./rate-limit.ts";
import type { RequestVariables } from "./request-logger.ts";

type ErrorCode = "RATE_LIMIT_EXCEEDED" | "UNAVAILABLE" | "INTERNAL_ERROR";
type AppEnv = { Variables: RequestVariables<ErrorCode> & { userId?: string; plan?: number } };

const appError = createAppError({
  RATE_LIMIT_EXCEEDED: 429,
  UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const);

const errorResponse = createErrorResponse<ErrorCode, string>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "INTERNAL_ERROR", message: "unused here" },
});

const refused: Array<[RefusedHit, string]> = [];
function refuse(hit: RefusedHit, scope: string) {
  refused.push([hit, scope]);
  return appError("RATE_LIMIT_EXCEEDED", "Too many requests", {
    retryAfterSecs: hit.retryAfterSecs,
  });
}

const downStore: WindowStore = {
  canFail: true,
  hit: () => Promise.reject(new Error("connection refused")),
};

function setup() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const app = new Hono<AppEnv>();
  app.onError(errorHandler({ errorResponse, logger }));
  app.use(async (c, next) => {
    const user = c.req.header("x-user");
    if (user) c.set("userId", user);
    c.set("plan", Number(c.req.header("x-plan") ?? 2));
    await next();
  });
  return { app, lines, logger };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(45_000);
  refused.length = 0;
});
afterEach(() => vi.useRealTimers());

describe("rateLimit", () => {
  it("answers the request past the limit with the product's 429 and the real wait", async () => {
    const { app } = setup();
    app.use(
      rateLimit<AppEnv>({
        scope: "app",
        store: memoryWindowStore(),
        limit: 2,
        windowMs: 60_000,
        key: (c) => c.get("userId") ?? null,
        refuse,
      }),
    );
    app.get("/", (c) => c.text("ok"));

    const statuses = [];
    for (let i = 0; i < 3; i++)
      statuses.push((await app.request("/", { headers: { "x-user": "u1" } })).status);
    const last = await app.request("/", { headers: { "x-user": "u1" } });

    expect(statuses).toEqual([200, 200, 429]);
    expect(last.headers.get("Retry-After")).toBe("15");
    expect(refused[0]).toEqual([expect.objectContaining({ outcome: "limited", count: 3 }), "app"]);
  });

  it("refuses a new caller when the memory store is full, and says it was shed", async () => {
    const { app } = setup();
    app.use(
      rateLimit<AppEnv>({
        scope: "ip",
        store: memoryWindowStore({ maxKeys: 1 }),
        limit: 100,
        windowMs: 60_000,
        key: (c) => c.get("userId") ?? null,
        refuse,
      }),
    );
    app.get("/", (c) => c.text("ok"));

    expect((await app.request("/", { headers: { "x-user": "first" } })).status).toBe(200);
    expect((await app.request("/", { headers: { "x-user": "second" } })).status).toBe(429);
    expect(refused[0]).toEqual([expect.objectContaining({ outcome: "shed" }), "ip"]);
  });

  it("lets a request with no subject through uncounted", async () => {
    const { app } = setup();
    app.use(
      rateLimit<AppEnv>({
        scope: "app",
        store: memoryWindowStore(),
        limit: 1,
        windowMs: 60_000,
        key: (c) => c.get("userId") ?? null,
        refuse,
      }),
    );
    app.get("/", (c) => c.text("ok"));

    for (let i = 0; i < 3; i++) expect((await app.request("/")).status).toBe(200);
  });

  it("reads the limit off the request, for a limit the caller's plan sets", async () => {
    const { app } = setup();
    app.use(
      rateLimit<AppEnv>({
        scope: "api",
        store: memoryWindowStore(),
        limit: (c) => c.get("plan") ?? 0,
        windowMs: 60_000,
        key: (c) => c.get("userId") ?? null,
        refuse,
      }),
    );
    app.get("/", (c) => c.text("ok"));

    const big = { "x-user": "big", "x-plan": "3" };
    const small = { "x-user": "small", "x-plan": "1" };
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push((await app.request("/", { headers: big })).status);
    for (let i = 0; i < 2; i++) answers.push((await app.request("/", { headers: small })).status);
    expect(answers).toEqual([200, 200, 200, 200, 429]);
  });

  it("keeps two limiters on one store apart by scope", async () => {
    const { app } = setup();
    const store = memoryWindowStore();
    const common = { store, limit: 1, windowMs: 60_000, key: () => "same", refuse };
    app.use("/a", rateLimit<AppEnv>({ ...common, scope: "a" }));
    app.use("/b", rateLimit<AppEnv>({ ...common, scope: "b" }));
    app.get("/a", (c) => c.text("a"));
    app.get("/b", (c) => c.text("b"));

    expect((await app.request("/a")).status).toBe(200);
    expect((await app.request("/b")).status).toBe(200);
  });

  it("lets a request through when the store is down and the limiter allows, and says so", async () => {
    const { app, lines, logger } = setup();
    app.use(
      rateLimit<AppEnv>({
        scope: "api",
        store: downStore,
        whenStoreFails: "allow",
        logger,
        limit: 1,
        windowMs: 60_000,
        key: () => "203.0.113.9",
        refuse,
      }),
    );
    app.get("/", (c) => c.text("ok"));

    expect((await app.request("/")).status).toBe(200);
    const line = lines.find((l) => l.message === "[rate-limit] the store did not answer");
    expect(line).toMatchObject({ level: "warn", scope: "api", allowed: true });
    // The subject is an address or an account, so it stays out of the line.
    expect(JSON.stringify(lines)).not.toContain("203.0.113.9");
  });

  it("refuses with the product's 503 when the store is down and the limiter refuses", async () => {
    const { app, lines, logger } = setup();
    const unavailable: unknown[] = [];
    app.use(
      rateLimit<AppEnv>({
        scope: "demo",
        store: downStore,
        whenStoreFails: (error, scope) => {
          unavailable.push([error, scope]);
          return appError("UNAVAILABLE", "This form is unavailable. Try again in a few minutes.");
        },
        logger,
        limit: 1,
        windowMs: 60_000,
        key: () => "ip",
        refuse,
      }),
    );
    app.get("/", (c) => c.text("ok"));

    expect((await app.request("/")).status).toBe(503);
    expect(unavailable).toEqual([[new Error("connection refused"), "demo"]]);
    expect(refused).toEqual([]);
    expect(lines).toContainEqual(expect.objectContaining({ scope: "demo", allowed: false }));
  });

  it("asks for a policy and a logger exactly when the store can fail", () => {
    const common = { scope: "s", limit: 1, windowMs: 1, key: () => "k", refuse };
    rateLimit({ ...common, store: memoryWindowStore() });
    // @ts-expect-error: a store that can fail needs `whenStoreFails` and `logger`.
    rateLimit({ ...common, store: downStore });
    // @ts-expect-error: and the logger, since an allowed failure is otherwise silent.
    rateLimit({ ...common, store: downStore, whenStoreFails: "allow" });
  });
});
