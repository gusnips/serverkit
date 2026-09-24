import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hitWindow,
  memoryWindowStore,
  type MemoryWindowStore,
  type WindowStore,
} from "./rate-limit.ts";

const MINUTE = 60_000;
const rule = { limit: 3, windowMs: MINUTE };

/** A store across the network that is down. */
const downStore: WindowStore = {
  canFail: true,
  hit: () => Promise.reject(new Error("connection refused")),
};

describe("hitWindow", () => {
  it("allows up to the limit and refuses the request after it", async () => {
    const store = memoryWindowStore();
    const outcomes = [];
    for (let i = 0; i < 4; i++) outcomes.push(await hitWindow(store, "k", rule, 1_000));
    expect(outcomes.map((hit) => [hit.outcome, "count" in hit ? hit.count : null])).toEqual([
      ["allowed", 1],
      ["allowed", 2],
      ["allowed", 3],
      ["limited", 4],
    ]);
  });

  it("lines windows up with the clock and states the real wait, never a constant", async () => {
    // A constant `retryAfter: 60` on a calendar minute overstates the wait by up to 59 s.
    const store = memoryWindowStore();
    const late = await hitWindow(store, "k", rule, 59_001);
    expect(late).toMatchObject({ resetAt: MINUTE, retryAfterSecs: 1 });
    const early = await hitWindow(store, "j", rule, 60_000);
    expect(early).toMatchObject({ count: 1, resetAt: 2 * MINUTE, retryAfterSecs: 60 });
  });

  it("starts a new count when the window closes", async () => {
    const store = memoryWindowStore();
    for (let i = 0; i < 4; i++) await hitWindow(store, "k", rule, 59_000);
    expect(await hitWindow(store, "k", rule, 60_000)).toMatchObject({
      outcome: "allowed",
      count: 1,
    });
  });

  it("counts each key on its own", async () => {
    const store = memoryWindowStore();
    for (let i = 0; i < 4; i++) await hitWindow(store, "a", rule, 0);
    expect(await hitWindow(store, "b", rule, 0)).toMatchObject({ outcome: "allowed", count: 1 });
  });

  it("allows or refuses a store failure by the limiter's own policy, and keeps the error", async () => {
    const allow = await hitWindow(downStore, "k", { ...rule, whenStoreFails: "allow" });
    const refuse = await hitWindow(downStore, "k", { ...rule, whenStoreFails: "refuse" });
    expect(allow).toMatchObject({ outcome: "store-failed", allowed: true });
    expect(refuse).toMatchObject({ outcome: "store-failed", allowed: false });
    expect(allow.outcome === "store-failed" && allow.error).toEqual(
      new Error("connection refused"),
    );
  });

  it("asks for a policy exactly when the store can fail", async () => {
    // @ts-expect-error: a store across the network needs `whenStoreFails`.
    await hitWindow(downStore, "k", rule).catch(() => {});
    // The memory store cannot fail, so it is not asked a question with no effect.
    await hitWindow(memoryWindowStore(), "k", rule);
  });

  it("rethrows when a store that says it cannot fail does", async () => {
    const lying: MemoryWindowStore = { canFail: false, hit: downStore.hit };
    await expect(hitWindow(lying, "k", rule)).rejects.toThrow("connection refused");
  });
});

describe("memoryWindowStore", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sheds a new key at the cap and keeps counting the keys it has", async () => {
    // Every spoofed address starts a new window, and inside one window none has expired, so
    // dropping expired windows alone cannot bound the map.
    const store = memoryWindowStore({ maxKeys: 2 });
    await hitWindow(store, "a", rule, 0);
    await hitWindow(store, "b", rule, 0);
    expect(await hitWindow(store, "c", rule, 30_000)).toEqual({
      outcome: "shed",
      allowed: false,
      limit: 3,
      resetAt: MINUTE,
      retryAfterSecs: 30,
    });
    expect(await hitWindow(store, "a", rule, 30_000)).toMatchObject({ count: 2 });
  });

  it("takes new keys again once the windows filling it have closed", async () => {
    const store = memoryWindowStore({ maxKeys: 2 });
    await hitWindow(store, "a", rule, 0);
    await hitWindow(store, "b", rule, 0);
    expect(await hitWindow(store, "c", rule, MINUTE)).toMatchObject({ outcome: "allowed" });
  });

  it("sweeps when the earliest window closes, even one added after the last sweep", async () => {
    const store = memoryWindowStore({ maxKeys: 2 });
    await hitWindow(store, "hour", { limit: 3, windowMs: 60 * MINUTE }, 0);
    await hitWindow(store, "minute", rule, 0);
    expect(await hitWindow(store, "new", rule, MINUTE)).toMatchObject({ outcome: "allowed" });
  });

  it("walks the map once per closed window, not once per shed request", async () => {
    // The copies that shed walked every key for every new key while full: a flood that fills
    // the map then costs a whole walk per request, which is the flood's goal.
    const store = memoryWindowStore({ maxKeys: 100 });
    for (let i = 0; i < 100; i++) await hitWindow(store, `fill-${i}`, rule, 0);
    const walks = vi.spyOn(Map.prototype, Symbol.iterator);
    for (let i = 0; i < 50; i++) await hitWindow(store, `flood-${i}`, rule, 1_000);
    // The next window: the first new key sweeps the closed one out, and the rest just count.
    for (let i = 0; i < 50; i++) await hitWindow(store, `later-${i}`, rule, MINUTE + 1_000);
    expect(walks).toHaveBeenCalledTimes(1);
  });
});
