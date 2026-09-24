/**
 * The README's examples, compiled and run.
 *
 * A snippet nobody executes rots quietly, and this one is the first thing an adopter copies.
 * Every literal below is what the README prints beside the call.
 */
import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  checkUrlShape,
  createAppError,
  hitWindow,
  createErrorResponse,
  createLogger,
  memoryWindowStore,
  nextHop,
  ok,
  paginated,
  readBounded,
} from "./index.ts";
import {
  assertEveryRouteGuarded,
  errorBoundary,
  errorHandler,
  guard,
  notFoundHandler,
  ok as okRoute,
  rateLimit,
  requestLogger,
  underAny,
} from "./hono/index.ts";
import type { RequestVariables } from "./hono/index.ts";
import { isAuthOutage } from "./supabase/index.ts";
import { createPgPool, pingPool } from "./pg/index.ts";
import { createRedis, redisWindowStore } from "./redis/index.ts";

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

describe("README — Supabase Auth", () => {
  it("answers the two lines the README prints beside the call", () => {
    // The README's own comment: true when auth failed to answer, false when it refused the token.
    expect(isAuthOutage(new AuthApiError("invalid JWT", 401, "bad_jwt"))).toBe(false);
    expect(isAuthOutage(new AuthRetryableFetchError("fetch failed", 0))).toBe(true);
    // And the 507 the README names as the hole the SDK's list leaves open.
    expect(isAuthOutage(new AuthApiError("proxy said 507", 507, undefined))).toBe(true);
  });
});

describe("README — Postgres", () => {
  it("bounds the wait and requires the handler, exactly as the section claims", () => {
    const onIdleError = () => {};
    const pool = createPgPool({ connectionString: "postgres://u@127.0.0.1:1/x", onIdleError });
    // "The default here is 10 seconds".
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    // "`onIdleError` is a required field, not an option" — the type says so, and the wiring is
    // what makes the requirement worth anything.
    expect(pool.listenerCount("error")).toBe(1);
    // "pass `connectionTimeoutMillis: 0` to wait forever on purpose".
    const queued = createPgPool({ connectionTimeoutMillis: 0, onIdleError });
    expect(queued.options.connectionTimeoutMillis).toBe(0);
  });

  it("gives the readiness call the deadline the section promises", async () => {
    const hung = { query: () => new Promise<never>(() => {}) };
    await expect(pingPool(hung, { timeoutMs: 20 })).resolves.toBe(false);
  });
});

describe("README — a URL somebody else gave you", () => {
  it("refuses the metadata service in the words the section prints", () => {
    expect(checkUrlShape("https://169.254.169.254/latest/meta-data/")).toEqual({
      ok: false,
      reason: "private-address",
    });
  });

  it("turns a POST answered by 302 into a GET, as the snippet says", () => {
    const url = new URL("https://api.example.com/hook");
    const response = new Response(null, { status: 302, headers: { location: "/moved" } });
    const headers = new Headers({ "content-type": "application/json" });
    expect(nextHop(url, response, { method: "POST", headers })).toMatchObject({
      ok: true,
      method: "GET",
      dropBody: true,
    });
  });

  it("stops at the limit it was given", async () => {
    const body = new Response("x".repeat(1_000_001)).body;
    const { bytes, truncated } = await readBounded(body, 1_000_000);
    expect(bytes.byteLength).toBe(1_000_000);
    expect(truncated).toBe(true);
  });
});

describe("README — a rate limit", () => {
  type AppEnv = { Variables: RequestVariables<ErrorCode> & { userId?: string } };
  afterEach(() => vi.useRealTimers());

  it("answers the 301st request in a minute with your 429 and the seconds left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 8, 24, 12, 0, 45));
    const logger = createLogger({ write: () => {} });
    const app = new Hono<AppEnv>();
    app.onError(errorHandler({ errorResponse, logger }));
    app.use((c, next) => (c.set("userId", "u1"), next()));
    app.use(
      "/app/*",
      rateLimit<AppEnv>({
        scope: "app",
        store: memoryWindowStore(),
        limit: 300,
        windowMs: 60_000,
        key: (c) => c.get("userId") ?? null,
        refuse: (hit) => errors.rateLimit(hit.retryAfterSecs),
      }),
    );
    app.get("/app/me", (c) => c.text("ok"));

    for (let i = 0; i < 300; i++) expect((await app.request("/app/me")).status).toBe(200);
    const refused = await app.request("/app/me");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("15");
  });

  it("builds the Redis example as printed", () => {
    const limitsRedis = createRedis({
      url: "redis://127.0.0.1:1",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1_000,
      lazyConnect: true,
      onError: () => {},
    });
    const logger = createLogger({ write: () => {} });
    const limit = rateLimit<AppEnv>({
      scope: "api",
      store: redisWindowStore(limitsRedis, { timeoutMs: 500 }),
      whenStoreFails: "allow",
      logger,
      limit: () => 60,
      windowMs: 60_000,
      key: (c) => c.get("userId") ?? null,
      refuse: (hit) => errors.rateLimit(hit.retryAfterSecs),
    });
    expect(typeof limit).toBe("function");
    limitsRedis.disconnect();
  });

  it("counts without Hono, and answers rather than throws", async () => {
    const store = memoryWindowStore();
    await hitWindow(store, "job:1", { limit: 1, windowMs: 60_000 }, 0);
    expect(await hitWindow(store, "job:1", { limit: 1, windowMs: 60_000 }, 0)).toMatchObject({
      outcome: "limited",
      allowed: false,
      retryAfterSecs: 60,
    });
  });
});
