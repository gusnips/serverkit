import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPgPool, DEFAULT_CONNECT_TIMEOUT_MS, pingPool } from "./index.ts";

/** A Pool never connects on construction, so every assertion below runs with no database. */
function pool(overrides: Partial<ConstructorParameters<typeof Pool>[0]> = {}) {
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
