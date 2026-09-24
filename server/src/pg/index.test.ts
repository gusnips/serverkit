import { Pool, TypeOverrides, types } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hasPostgres, startPostgres } from "../__tests__/postgres-server.ts";
import { createPgPool, DEFAULT_CONNECT_TIMEOUT_MS, pingPool, type PgPoolOptions } from "./index.ts";

/** A Pool never connects on construction, so every assertion below runs with no database. */
function pool(overrides: Partial<PgPoolOptions> = {}) {
  return createPgPool({
    connectionString: "postgres://u@127.0.0.1:1/x",
    onIdleError: () => {},
    ...overrides,
  });
}

describe("createPgPool", () => {
  it("bounds the wait for a free connection, which is the whole reason it exists", () => {
    // With this unset, pg-pool pushes the caller onto `_pendingQueue` with no timer and it waits
    // forever — read in pg-pool@3.14.0, and the state ten of eleven backends shipped.
    expect(pool().options.connectionTimeoutMillis).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
  });

  it("lets a caller opt back into waiting forever, deliberately", () => {
    // A batch job that would rather queue than fail is a real case. It has to be spelled, not
    // reached by omission — that is the entire difference this module makes.
    expect(pool({ connectionTimeoutMillis: 0 }).options.connectionTimeoutMillis).toBe(0);
    expect(pool({ connectionTimeoutMillis: 500 }).options.connectionTimeoutMillis).toBe(500);
  });

  it("passes the rest of PoolConfig straight through", () => {
    const p = pool({ max: 3, options: "-c search_path=app" });
    expect(p.options.max).toBe(3);
    expect(p.options.options).toBe("-c search_path=app");
  });

  it("attaches the idle-error listener, so the pool cannot take the process down", () => {
    const onIdleError = vi.fn();
    const p = createPgPool({ connectionString: "postgres://u@127.0.0.1:1/x", onIdleError });
    // One listener is the assertion: with zero, Node escalates the emit to an uncaught exception
    // and a backend whose crash handler exits dies on a connection nobody was using.
    expect(p.listenerCount("error")).toBe(1);
    const boom = new Error("terminating connection due to administrator command");
    p.emit("error", boom);
    expect(onIdleError).toHaveBeenCalledWith(boom);
  });
});

describe("createPgPool date columns", () => {
  const parse = (p: Pool, oid: number, text: string): unknown =>
    p.options.types?.getTypeParser(oid, "text")(text);

  it("reads a date as the day Postgres wrote, not a midnight in the box's zone", () => {
    const p = pool();
    expect(parse(p, 1082, "2026-09-23")).toBe("2026-09-23");
    // A BC date is quoted inside an array, and NULL is not the string "NULL".
    expect(parse(p, 1182, '{2026-09-23,NULL,"0044-03-15 BC"}')).toEqual([
      "2026-09-23",
      null,
      "0044-03-15 BC",
    ]);
  });

  it("changes only date, and only on this pool", () => {
    const p = pool();
    // A timestamptz is a real instant, so it stays a Date.
    expect(parse(p, 1184, "2026-09-23 12:00:00+00")).toBeInstanceOf(Date);
    // The process-wide parser is untouched, so another pool or library still gets a Date.
    expect(types.getTypeParser(1082, "text")("2026-09-23")).toBeInstanceOf(Date);
  });

  it("keeps the caller's own parsers for everything else", () => {
    const own = new TypeOverrides();
    own.setTypeParser(20, "text", (value) => BigInt(value));
    const p = pool({ types: own });
    expect(parse(p, 20, "9007199254740993")).toBe(9007199254740993n);
    expect(parse(p, 1082, "2026-09-23")).toBe("2026-09-23");
  });

  it('hands dates back to pg with dateColumns: "date"', () => {
    expect(parse(pool({ dateColumns: "date" }), 1082, "2026-09-23")).toBeUndefined();
  });
});

describe.skipIf(!hasPostgres)("createPgPool date columns against a real Postgres", () => {
  let server: Awaited<ReturnType<typeof startPostgres>>;

  beforeAll(async () => {
    server = await startPostgres();
  }, 30_000);

  afterAll(async () => {
    await server.stop();
  });

  it("returns the day as a string, while a plain Pool in the same process still gets a Date", async () => {
    const sql = `SELECT '2026-09-23'::date AS day,
                        ARRAY['2026-09-23'::date, NULL] AS days,
                        '2026-09-23T12:00:00Z'::timestamptz AS at`;
    const ours = createPgPool({ connectionString: server.url, onIdleError: () => {} });
    const plain = new Pool({ connectionString: server.url });
    try {
      const { rows } = await ours.query(sql);
      expect(rows[0]).toEqual({
        day: "2026-09-23",
        days: ["2026-09-23", null],
        at: new Date("2026-09-23T12:00:00Z"),
      });
      expect((await plain.query(sql)).rows[0].day).toBeInstanceOf(Date);
    } finally {
      await Promise.all([ours.end(), plain.end()]);
    }
  });
});

describe("pingPool", () => {
  it("answers true when the database answers", async () => {
    await expect(
      pingPool({ query: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }) }),
    ).resolves.toBe(true);
  });

  it("answers false rather than throwing, so /health can name the dependency", async () => {
    const onError = vi.fn();
    const failed = new Error("ECONNREFUSED");
    await expect(pingPool({ query: vi.fn().mockRejectedValue(failed) }, { onError })).resolves.toBe(
      false,
    );
    // A ping that answers false and says nothing reports a dependency down without saying why.
    expect(onError).toHaveBeenCalledWith(failed);
  });

  it("is BOUNDED — a hung database does not hang the probe", async () => {
    const onError = vi.fn();
    // Never settles. Four backends run this query raw, so this case hangs /health, which an
    // orchestrator reads as "unknown" where false would have meant "replace this container".
    const hung = { query: vi.fn(() => new Promise<never>(() => {})) };
    const started = Date.now();
    await expect(pingPool(hung, { timeoutMs: 20, onError })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(String(onError.mock.calls[0]?.[0])).toContain("timed out");
  });

  it("clears its timer on the fast path", async () => {
    // The one bounded copy in the fleet forgot this: an uncleared 2s timer per probe, in a
    // process something polls every few seconds. `vi.getTimerCount()` is what proves it.
    vi.useFakeTimers();
    try {
      await pingPool({ query: vi.fn().mockResolvedValue({ rows: [] }) }, { timeoutMs: 2_000 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
