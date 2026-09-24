import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hasPostgres, startPostgres } from "../__tests__/postgres-server.ts";
import { createIdempotency } from "./idempotency.ts";

/** The README's own `CREATE TABLE`, so the table the docs tell you to make is the one tested. */
const TABLE_SQL = /```sql\n(CREATE TABLE app\.idempotency_keys[\s\S]*?)```/.exec(
  readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
)?.[1];

const SCOPE = { owner: "ws-1", operation: "send_message", key: "k-1" };

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe.skipIf(!hasPostgres)("createIdempotency against a real Postgres", () => {
  let server: Awaited<ReturnType<typeof startPostgres>>;
  let pool: Pool;
  let errors: unknown[];
  let store: ReturnType<typeof createIdempotency>;

  beforeAll(async () => {
    server = await startPostgres();
    pool = new Pool({ connectionString: server.url, max: 30 });
    await pool.query("CREATE SCHEMA app");
    if (!TABLE_SQL) throw new Error("The README's CREATE TABLE for idempotency_keys is gone");
    await pool.query(TABLE_SQL);
  }, 30_000);

  afterAll(async () => {
    await pool.end();
    await server.stop();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE app.idempotency_keys");
    errors = [];
    store = createIdempotency(pool, {
      table: "app.idempotency_keys",
      onError: (error) => errors.push(error),
    });
  });

  const backdate = (secs: number) =>
    pool.query(
      "UPDATE app.idempotency_keys SET created_at = created_at - make_interval(secs => $1)",
      [secs],
    );

  it("runs once, then hands the same answer back in the same key order", async () => {
    let runs = 0;
    const work = async () => ({ zeta: 1, alpha: [{ b: 2, a: 1 }], runs: ++runs });
    expect(await store.run(SCOPE, { to: "x" }, work)).toEqual({
      kind: "ran",
      answer: { zeta: 1, alpha: [{ b: 2, a: 1 }], runs: 1 },
    });
    const replay = await store.run(SCOPE, { to: "x" }, work);
    expect(replay).toEqual({
      kind: "replayed",
      answer: { zeta: 1, alpha: [{ b: 2, a: 1 }], runs: 1 },
    });
    expect(JSON.stringify(replay.kind === "replayed" && replay.answer)).toBe(
      '{"zeta":1,"alpha":[{"b":2,"a":1}],"runs":1}',
    );
    expect(runs).toBe(1);
  });

  it("refuses the key for other input or another operation, and keeps owners apart", async () => {
    const work = async () => "sent";
    await store.run(SCOPE, { to: "x" }, work);
    expect(await store.run(SCOPE, { to: "y" }, work)).toEqual({ kind: "mismatch" });
    expect(await store.run({ ...SCOPE, operation: "delete_message" }, { to: "x" }, work)).toEqual({
      kind: "mismatch",
    });
    expect(await store.run({ ...SCOPE, owner: "ws-2" }, { to: "y" }, work)).toEqual({
      kind: "ran",
      answer: "sent",
    });
  });

  it("reads the same request in any key order, and a date by its value", async () => {
    const work = async () => "ok";
    await store.run(SCOPE, { a: 1, b: { d: 2, c: new Date("2026-01-01") } }, work);
    expect(
      (await store.run(SCOPE, { b: { c: new Date("2026-01-01"), d: 2 }, a: 1 }, work)).kind,
    ).toBe("replayed");
    expect(
      (await store.run(SCOPE, { a: 1, b: { c: new Date("2027-06-01"), d: 2 } }, work)).kind,
    ).toBe("mismatch");
  });

  it("just runs, and keeps nothing, with no key", async () => {
    for (const key of [undefined, null, ""])
      expect(await store.run({ ...SCOPE, key }, {}, async () => 1)).toEqual({
        kind: "ran",
        answer: 1,
      });
    expect((await pool.query("SELECT 1 FROM app.idempotency_keys")).rowCount).toBe(0);
  });

  it("lets exactly one of twenty requests with one key run", async () => {
    const { open, opened } = gate();
    let runs = 0;
    let settled = 0;
    const outcomes = Promise.all(
      Array.from({ length: 20 }, () =>
        store
          .run(SCOPE, {}, async () => {
            runs++;
            await opened;
            return "done";
          })
          .finally(() => settled++),
      ),
    );
    // Held open until the other nineteen have answered, so all twenty overlap however slow the
    // machine is. A second run would never settle, and the test would time out.
    while (settled < 19) await new Promise((r) => setTimeout(r, 10));
    open();
    const kinds = (await outcomes).map((outcome) => outcome.kind).sort();
    expect(runs).toBe(1);
    expect(kinds.filter((kind) => kind === "ran")).toHaveLength(1);
    expect(kinds.filter((kind) => kind === "running")).toHaveLength(19);
  });

  it("lets the key go when the work throws, so the retry runs", async () => {
    const failed = store.run(SCOPE, {}, async () => {
      throw new Error("provider down");
    });
    await expect(failed).rejects.toThrow("provider down");
    expect(await store.run(SCOPE, {}, async () => "sent")).toEqual({ kind: "ran", answer: "sent" });
  });

  it("takes over a claim nobody answered, but only for the same request", async () => {
    const started = gate();
    void store.run(SCOPE, { to: "x" }, () => {
      started.open();
      return gate().opened;
    });
    await started.opened;
    expect(await store.run(SCOPE, { to: "x" }, async () => "late")).toEqual({ kind: "running" });
    await backdate(901);
    expect(await store.run(SCOPE, { to: "y" }, async () => "other")).toEqual({ kind: "mismatch" });
    expect(await store.run(SCOPE, { to: "x" }, async () => "again")).toEqual({
      kind: "ran",
      answer: "again",
    });
  });

  it("does not let a run that was taken over touch the new claim", async () => {
    const first = gate();
    const firstStarted = gate();
    const firstRun = store.run(SCOPE, {}, async () => {
      firstStarted.open();
      await first.opened;
      return "first";
    });
    await firstStarted.opened;
    await backdate(901);
    expect(await store.run(SCOPE, {}, async () => "second")).toEqual({
      kind: "ran",
      answer: "second",
    });
    first.open();
    expect(await firstRun).toEqual({ kind: "ran", answer: "first" });
    expect(await store.run(SCOPE, {}, async () => "third")).toEqual({
      kind: "replayed",
      answer: "second",
    });
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("The answer to send_message was not kept");

    // A taken-over run that THROWS must not delete the claim that replaced it either.
    await pool.query("TRUNCATE app.idempotency_keys");
    const doomed = gate();
    const doomedStarted = gate();
    const doomedRun = store.run(SCOPE, {}, async () => {
      doomedStarted.open();
      await doomed.opened;
      throw new Error("late failure");
    });
    await doomedStarted.opened;
    await backdate(901);
    const replacementStarted = gate();
    void store.run(SCOPE, {}, () => {
      replacementStarted.open();
      return gate().opened;
    });
    await replacementStarted.opened;
    doomed.open();
    await expect(doomedRun).rejects.toThrow("late failure");
    expect(await store.run(SCOPE, {}, async () => "fourth")).toEqual({ kind: "running" });
  });

  it("still answers when the answer cannot be kept, and holds the key", async () => {
    expect(await store.run(SCOPE, {}, async () => ({ big: 1n }))).toEqual({
      kind: "ran",
      answer: { big: 1n },
    });
    expect(errors).toHaveLength(1);
    expect(await store.run(SCOPE, {}, async () => ({ big: 2n }))).toEqual({ kind: "running" });
  });

  it("replays an answer of null or nothing as null, not as still running", async () => {
    await store.run(SCOPE, {}, async () => undefined);
    expect(await store.run(SCOPE, {}, async () => undefined)).toEqual({
      kind: "replayed",
      answer: null,
    });
  });

  it("runs again once the answer is older than replaySecs", async () => {
    await store.run(SCOPE, { to: "x" }, async () => "first");
    await backdate(86_401);
    expect(await store.run(SCOPE, { to: "y" }, async () => "new")).toEqual({
      kind: "ran",
      answer: "new",
    });
  });

  it("takes a key of any length", async () => {
    // Random, because a repeated character compresses small enough to fit the index unhashed.
    const key = Array.from({ length: 300 }, () => crypto.randomUUID()).join("");
    await store.run({ ...SCOPE, key }, {}, async () => 1);
    expect((await store.run({ ...SCOPE, key }, {}, async () => 2)).kind).toBe("replayed");
  });

  it("prunes only answers past replaySecs, in batches", async () => {
    for (let i = 0; i < 5; i++) await store.run({ ...SCOPE, key: `old-${i}` }, {}, async () => i);
    await backdate(86_401);
    await store.run({ ...SCOPE, key: "fresh" }, {}, async () => "kept");
    expect(await store.prune(2)).toBe(5);
    expect((await pool.query("SELECT 1 FROM app.idempotency_keys")).rowCount).toBe(1);
  });

  it("refuses a table name it would have to quote", () => {
    for (const table of ["app.keys; DROP TABLE users", "a.b.c", ""])
      expect(() => createIdempotency(pool, { table, onError: () => {} })).toThrow(TypeError);
  });
});
