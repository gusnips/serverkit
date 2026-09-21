import { describe, expect, it, vi } from "vitest";
import { assertRedisReachable, createRedis, pingRedis } from "./index.ts";

/** `lazyConnect` so nothing dials while these run. Every assertion below needs no Redis. */
function client(overrides: Record<string, unknown> = {}) {
  return createRedis({
    url: "redis://127.0.0.1:1",
    lazyConnect: true,
    onError: () => {},
    ...overrides,
  });
}

describe("createRedis", () => {
  it("defaults maxRetriesPerRequest to null, which is what BullMQ requires", () => {
    // Every copy in the fleet sets it: BullMQ's blocking reads must never be cut short by a
    // retry limit. It is also what makes every OTHER read on this connection unbounded.
    expect(client().options.maxRetriesPerRequest).toBeNull();
  });

  it("lets a caller ask for a retry limit instead", () => {
    // A connection serving ordinary commands rather than BullMQ's blocking ones wants one.
    expect(client({ maxRetriesPerRequest: 3 }).options.maxRetriesPerRequest).toBe(3);
  });

  it("passes the rest of RedisOptions straight through", () => {
    const c = client({ db: 4, keepAlive: 30_000, connectTimeout: 10_000 });
    expect(c.options.db).toBe(4);
    expect(c.options.keepAlive).toBe(30_000);
    expect(c.options.connectTimeout).toBe(10_000);
  });

  it("connects from options when no url is given", () => {
    // Three backends in the fleet configure host/port/db rather than a URL.
    const c = createRedis({ host: "127.0.0.1", port: 1, lazyConnect: true, onError: () => {} });
    expect(c.options.host).toBe("127.0.0.1");
    expect(c.options.port).toBe(1);
  });

  it("attaches the error listener, so a blip cannot take the process down", () => {
    const onError = vi.fn();
    const c = createRedis({ url: "redis://127.0.0.1:1", lazyConnect: true, onError });
    // One listener is the assertion: with zero, ioredis's emit on a failed connect becomes an
    // uncaught exception, and a backend whose crash handler exits dies on a reconnect it would
    // have made by itself.
    expect(c.listenerCount("error")).toBe(1);
    const boom = new Error("ECONNREFUSED");
    c.emit("error", boom);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe("pingRedis", () => {
  it("answers true on PONG", async () => {
    await expect(pingRedis({ ping: vi.fn().mockResolvedValue("PONG") })).resolves.toBe(true);
  });

  it("answers false for an answer that is not PONG", async () => {
    // A reply that is not PONG is not a working Redis, and reading the truthiness of a string
    // would call every one of them healthy.
    await expect(pingRedis({ ping: vi.fn().mockResolvedValue("LOADING") })).resolves.toBe(false);
  });

  it("answers false rather than throwing, so /health can name the dependency", async () => {
    const onError = vi.fn();
    const failed = new Error("ECONNREFUSED");
    await expect(pingRedis({ ping: vi.fn().mockRejectedValue(failed) }, { onError })).resolves.toBe(
      false,
    );
    expect(onError).toHaveBeenCalledWith(failed);
  });

  it("is BOUNDED — and this connection is exactly the one that needs it", async () => {
    const onError = vi.fn();
    // With maxRetriesPerRequest null, a command against a down Redis does not fail, it waits.
    // Five backends in the fleet have Redis and no bounded probe for it at all.
    const hung = { ping: vi.fn(() => new Promise<never>(() => {})) };
    const started = Date.now();
    await expect(pingRedis(hung, { timeoutMs: 20, onError })).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(String(onError.mock.calls[0]?.[0])).toContain("timed out");
  });

  it("clears its timer on the fast path", async () => {
    // All FOUR hand-written copies forgot this: a pending 2s timer per health check, in a
    // process something probes every few seconds.
    vi.useFakeTimers();
    try {
      await pingRedis({ ping: vi.fn().mockResolvedValue("PONG") }, { timeoutMs: 2_000 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("assertRedisReachable", () => {
  it("returns quietly when Redis answers", async () => {
    await expect(
      assertRedisReachable({ ping: vi.fn().mockResolvedValue("PONG") }),
    ).resolves.toBeUndefined();
  });

  it("names the host and never the password", async () => {
    const down = { ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    const url = "redis://default:hunter2@cache.internal:6379";
    await expect(assertRedisReachable(down, { url, timeoutMs: 20 })).rejects.toThrow(
      /cache\.internal:6379/,
    );
    // The reason this takes a URL and parses it rather than a string to interpolate.
    await expect(assertRedisReachable(down, { url, timeoutMs: 20 })).rejects.not.toThrow(/hunter2/);
  });

  it("says something readable when the url is missing or unparseable", async () => {
    // This only ever runs while something is already failing; a throw from the error path
    // replaces the message that was about to explain the outage.
    const down = { ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
    await expect(assertRedisReachable(down, { timeoutMs: 20 })).rejects.toThrow(/no url given/);
    await expect(assertRedisReachable(down, { url: "not a url", timeoutMs: 20 })).rejects.toThrow(
      /unparseable url/,
    );
  });
});

describe("assertRedisReachable's hint", () => {
  const down = { ping: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };

  it("appends what to do about it, which a package cannot know", async () => {
    // Two of the three hand-written gates said "check REDIS_URL"; the third named the command
    // that starts one. The third is the only message a reader can act on without already
    // knowing the repo, and it is the half that has to come from the caller.
    await expect(
      assertRedisReachable(down, {
        url: "redis://127.0.0.1:6379",
        timeoutMs: 20,
        hint: "Start it (the dev compose runs one) or fix REDIS_URL.",
      }),
    ).rejects.toThrow(/It is down, or the URL is wrong\. Start it \(the dev compose runs one\)/);
  });

  it("leaves no dangling space when there is no hint", async () => {
    await expect(assertRedisReachable(down, { timeoutMs: 20 })).rejects.toThrow(/wrong\.$/);
  });
});
