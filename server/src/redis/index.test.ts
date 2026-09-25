import { createServer, type AddressInfo, type Socket } from "node:net";
import IORedis from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { freePort } from "../__tests__/redis-server.ts";
import { assertRedisReachable, createRedis, pingRedis, quitRedis } from "./index.ts";

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

  it("attaches the error listener, so a failed connect reaches the app's logger", () => {
    const onError = vi.fn();
    const c = createRedis({ url: "redis://127.0.0.1:1", lazyConnect: true, onError });
    // One listener is the assertion: with zero, ioredis prints a bare stack to stderr and the
    // app's own log says nothing. It does not crash the process; see `onError` in index.ts.
    expect(c.listenerCount("error")).toBe(1);
    const boom = new Error("ECONNREFUSED");
    c.emit("error", boom);
    expect(onError).toHaveBeenCalledWith(boom);
  });
});

describe("createRedis and a URL with options in it", () => {
  it("is guarding against what ioredis does: the query beats the options, as strings", () => {
    // ioredis itself, with no createRedis in between. When this stops holding, the guard below
    // may have stopped being needed.
    const raw = new IORedis("redis://127.0.0.1:1?maxRetriesPerRequest=7&enableOfflineQueue=false", {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableOfflineQueue: true,
    });
    expect(raw.options.maxRetriesPerRequest).toBe("7");
    expect(raw.options.enableOfflineQueue).toBe("false");
  });

  it("refuses the URL, and says nothing that was in it", () => {
    for (const url of [
      "redis://:hunter2@127.0.0.1:1/0?maxRetriesPerRequest=7",
      "redis://127.0.0.1:1?family=6",
      "redis://:hunter2?@127.0.0.1:1",
      "/tmp/redis.sock?db=2",
    ]) {
      const message = (() => {
        try {
          client({ url });
          return "did not throw";
        } catch (error) {
          return String(error);
        }
      })();
      expect(message).toContain('The Redis URL has options after its "?"');
      expect(message).not.toContain("hunter2");
    }
  });

  it("takes a URL with nothing after its ?", () => {
    expect(client({ url: "redis://127.0.0.1:1?" }).options.port).toBe(1);
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

describe("what onError is actually for", () => {
  // The four donors all say a missing `error` listener crashes the process. It does not, and
  // this pins the vendor behaviour their sentence got wrong — because the doc on `onError` now
  // makes a claim about ioredis's internals, and a claim nothing checks is one that rots.
  //
  // `silentEmit` looks at the listener count and, finding none, writes the error to
  // `console.error` and returns WITHOUT emitting. So Node's unhandled-'error' throw is
  // unreachable, and the real cost of forgetting the listener is that the only signal lands on
  // stderr instead of in the app's logger. If ioredis ever drops that guard, this test fails and
  // the reasoning in the doc has to change with it.
  it("sends a listener-less client's error to console.error, not to a throw", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Port 1 refuses immediately; `retryStrategy: () => null` stops after the first failure, so
    // this costs one connect attempt rather than a backoff loop.
    const raw = new (await import("ioredis")).default("redis://127.0.0.1:1", {
      lazyConnect: true,
      retryStrategy: () => null,
    });
    await expect(raw.connect()).rejects.toThrow();
    expect(spy).toHaveBeenCalledWith(
      "[ioredis] Unhandled error event:",
      expect.stringContaining("ECONNREFUSED"),
    );
    raw.disconnect();
    spy.mockRestore();
  });
});

/** Whether `promise` settles within `ms`, either way. */
function settlesWithin(ms: number, promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

/** Redis unreachable, with a PING waiting in the offline queue, as a health probe leaves one. */
async function unreachableWithAWaitingPing() {
  const redis = createRedis({ url: `redis://127.0.0.1:${await freePort()}`, onError: () => {} });
  redis.ping().catch(() => {});
  return redis;
}

/** A Redis that accepted the connection and then froze: nothing it is sent is ever answered. */
async function frozenRedis() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => void sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  // No ready check and no CLIENT SETINFO, so the connection is "ready" once the socket opens:
  // the same state as a real Redis that answered those and froze afterwards.
  const redis = createRedis({
    url: `redis://127.0.0.1:${port}`,
    enableReadyCheck: false,
    disableClientInfo: true,
    onError: () => {},
  });
  await new Promise((resolve) => redis.once("ready", resolve));
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return { redis, close };
}

describe("quitRedis", () => {
  // The two controls pin the ioredis behaviour the function exists for. When one stops holding,
  // that half of the doc comment is out of date.
  it("is guarding against ioredis: quit() waits on the offline queue", async () => {
    const redis = await unreachableWithAWaitingPing();
    expect(await settlesWithin(300, redis.quit())).toBe(false);
    redis.disconnect();
  });

  it("is guarding against a frozen Redis: QUIT is never answered", async () => {
    const { redis, close } = await frozenRedis();
    expect(await settlesWithin(300, redis.quit())).toBe(false);
    redis.disconnect();
    close();
  });

  it("closes at once when Redis is unreachable and a command is waiting", async () => {
    const redis = await unreachableWithAWaitingPing();
    expect(await settlesWithin(100, quitRedis(redis))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(redis.status).toBe("end");
  });

  it("closes the socket after the bound when Redis is frozen", async () => {
    // The socket closes only once the peer answers the FIN, and a frozen one never does, so what
    // this can assert is that the drain moves on and the socket was told to close.
    const { redis, close } = await frozenRedis();
    const disconnect = vi.spyOn(redis, "disconnect");
    const started = Date.now();
    await quitRedis(redis, { timeoutMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    expect(disconnect).toHaveBeenCalledOnce();
    close();
  });

  it("sends QUIT and leaves the socket alone when Redis answers", async () => {
    const calls: string[] = [];
    await quitRedis({
      status: "ready",
      quit: async () => (calls.push("quit"), "OK" as const),
      disconnect: () => void calls.push("disconnect"),
    });
    expect(calls).toEqual(["quit"]);
  });

  it("closes the socket when QUIT is refused, and does not throw", async () => {
    const calls: string[] = [];
    await quitRedis({
      status: "ready",
      quit: async () => {
        throw new Error("Connection is closed.");
      },
      disconnect: () => void calls.push("disconnect"),
    });
    expect(calls).toEqual(["disconnect"]);
  });
});
