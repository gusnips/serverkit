import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasRedisServer, startRedisServer } from "../__tests__/redis-server.ts";
import { hitWindow } from "../rate-limit.ts";
import { createRedis } from "./index.ts";
import { redisWindowStore, type WindowPipeline } from "./window-store.ts";

type Reply = [Error | null, unknown][] | null;

/** Records what one MULTI would have sent, and answers with `reply`. */
function stubRedis(reply: () => Promise<Reply>) {
  const sent: unknown[][] = [];
  const pipeline: WindowPipeline = {
    incr: (key) => (sent.push(["incr", key]), pipeline),
    pexpire: (key, ms) => (sent.push(["pexpire", key, ms]), pipeline),
    exec: reply,
  };
  return { sent, redis: { multi: () => pipeline } };
}

const rule = { limit: 2, windowMs: 60_000, whenStoreFails: "refuse" } as const;

describe("redisWindowStore", () => {
  it("counts and re-arms the expiry in one MULTI, under its prefix", async () => {
    const { sent, redis } = stubRedis(async () => [
      [null, 1],
      [null, 1],
    ]);
    const hit = await hitWindow(
      redisWindowStore(redis, { timeoutMs: 100 }),
      "api:u1",
      rule,
      45_000,
    );
    expect(hit).toMatchObject({ outcome: "allowed", count: 1 });
    // Expires a second after the window closes: 15 s left, plus one.
    expect(sent).toEqual([
      ["incr", "rl:api:u1:0"],
      ["pexpire", "rl:api:u1:0", 16_000],
    ]);
  });

  it("reads a refused INCR as a store failure, not as a count", async () => {
    const { redis } = stubRedis(async () => [[new Error("OOM"), null]]);
    const hit = await hitWindow(redisWindowStore(redis, { timeoutMs: 100 }), "k", rule);
    expect(hit).toMatchObject({ outcome: "store-failed", allowed: false, error: new Error("OOM") });
  });

  it("reads an answer that is not a number as a store failure", async () => {
    const { redis } = stubRedis(async () => null);
    const hit = await hitWindow(redisWindowStore(redis, { timeoutMs: 100 }), "k", rule);
    expect(hit).toMatchObject({ outcome: "store-failed" });
  });

  it("gives up at timeoutMs on the connection BullMQ needs, where the MULTI never answers", async () => {
    // `maxRetriesPerRequest: null` against a closed port: the fleet's "fail open" limiters
    // waited here, and so did every request behind them.
    const redis = createRedis({ url: "redis://127.0.0.1:1", onError: () => {} });
    try {
      const started = Date.now();
      const hit = await hitWindow(redisWindowStore(redis, { timeoutMs: 200 }), "k", {
        ...rule,
        whenStoreFails: "allow",
      });
      expect(hit).toMatchObject({ outcome: "store-failed", allowed: true });
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      redis.disconnect();
    }
  });

  it("fails at once on the connection the doc recommends", async () => {
    const redis = createRedis({
      url: "redis://127.0.0.1:1",
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: 1_000,
      onError: () => {},
    });
    try {
      const started = Date.now();
      const hit = await hitWindow(redisWindowStore(redis, { timeoutMs: 5_000 }), "k", rule);
      expect(hit).toMatchObject({ outcome: "store-failed" });
      expect(Date.now() - started).toBeLessThan(100);
    } finally {
      redis.disconnect();
    }
  });
});

describe.skipIf(!hasRedisServer)("redisWindowStore against a real Redis", () => {
  let server: Awaited<ReturnType<typeof startRedisServer>>;
  let url: string;

  beforeAll(async () => {
    server = await startRedisServer();
    url = server.url;
  });

  afterAll(() => {
    server.stop();
  });

  it("shares one count between two processes, and sets the expiry it promised", async () => {
    const a = createRedis({ url, maxRetriesPerRequest: 1, onError: () => {} });
    const b = createRedis({ url, maxRetriesPerRequest: 1, onError: () => {} });
    try {
      const now = Date.now();
      const hits = [
        await hitWindow(redisWindowStore(a, { timeoutMs: 1_000 }), "shared", rule, now),
        await hitWindow(redisWindowStore(b, { timeoutMs: 1_000 }), "shared", rule, now),
        await hitWindow(redisWindowStore(a, { timeoutMs: 1_000 }), "shared", rule, now),
      ];
      expect(hits.map((hit) => hit.outcome)).toEqual(["allowed", "allowed", "limited"]);

      const index = Math.floor(now / rule.windowMs);
      const ttl = await a.pttl(`rl:shared:${index}`);
      const promised = (index + 1) * rule.windowMs - now + 1_000;
      expect(ttl).toBeGreaterThan(promised - 1_000);
      expect(ttl).toBeLessThanOrEqual(promised);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });
});
