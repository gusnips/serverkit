import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unreadableTablesCheck } from "./checks.ts";
import { runMigrations, type MigrateOptions } from "./runner.ts";
import {
  captureLog,
  freshDatabase,
  migrationsDir,
  removeDir,
  urlFor,
  type TestDatabase,
} from "./test/db.ts";

let db: TestDatabase;
let dirs: string[] = [];

beforeEach(async () => {
  db = await freshDatabase();
});

afterEach(async () => {
  await db.drop();
  for (const dir of dirs) await removeDir(dir);
  dirs = [];
});

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await migrationsDir(files);
  dirs.push(dir);
  return dir;
}

async function migrate(dir: string, options: Partial<MigrateOptions> = {}) {
  const log = captureLog();
  const result = await runMigrations({ dir, databaseUrl: db.url, confirm: null, log, ...options });
  return { ...result, log };
}

const versions = async () =>
  (
    await db.query<{ version: string }>(
      'SELECT version FROM app."schema_migrations" ORDER BY applied_at, version',
    )
  ).map((row) => row.version);
const exists = async (regclass: string) =>
  (await db.query<{ found: boolean }>("SELECT to_regclass($1) IS NOT NULL AS found", [regclass]))[0]
    ?.found;
const schemaExists = async (name: string) =>
  (await db.query<{ found: boolean }>("SELECT to_regnamespace($1) IS NOT NULL AS found", [name]))[0]
    ?.found;

/** A second session that holds the runner's advisory lock until released. */
async function holdLock(key = 727_001_001) {
  const client = new Client({ connectionString: db.url, application_name: "lock-holder" });
  await client.connect();
  await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
  return { client, release: () => client.end() };
}

describe("applying", () => {
  it("applies .sql files in numeric order and records each version", async () => {
    const dir = await folder({
      "10_c.sql": "INSERT INTO app.seen VALUES (10);",
      "2_b.sql": "INSERT INTO app.seen VALUES (2);",
      "1_a.sql": "CREATE SCHEMA IF NOT EXISTS app; CREATE TABLE app.seen (n int, at serial);",
      "README.md": "not a migration",
    });
    const run = await migrate(dir);
    expect(run.exitCode).toBe(0);
    expect(run.applied).toEqual(["1_a.sql", "2_b.sql", "10_c.sql"]);
    expect(
      (await db.query<{ n: number }>("SELECT n FROM app.seen ORDER BY at")).map((r) => r.n),
    ).toEqual([2, 10]);
    expect(await versions()).toEqual(["1_a", "2_b", "10_c"]);
  });

  it("treats files that share a number as separate versions", async () => {
    const dir = await folder({ "004_a.sql": "SELECT 1;", "004_b.sql": "SELECT 2;" });
    expect((await migrate(dir)).applied).toEqual(["004_a.sql", "004_b.sql"]);
  });

  it("creates the tracking table every earlier runner used, with no row level security by default", async () => {
    await migrate(await folder({ "1_a.sql": "SELECT 1;" }));
    const columns = await db.query(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'schema_migrations' ORDER BY ordinal_position`,
    );
    expect(columns).toEqual([
      { column_name: "version", data_type: "text", is_nullable: "NO", column_default: null },
      {
        column_name: "applied_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
        column_default: "now()",
      },
    ]);
    const rls = await db.query<{ on: boolean }>(
      "SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'app.schema_migrations'::regclass",
    );
    expect(rls[0]?.on).toBe(false);
  });

  it("turns row level security on for the tracking table when asked", async () => {
    await migrate(await folder({ "1_a.sql": "SELECT 1;" }), { rlsOnTrackingTable: true });
    const rls = await db.query<{ on: boolean }>(
      "SELECT relrowsecurity AS on FROM pg_class WHERE oid = 'app.schema_migrations'::regclass",
    );
    expect(rls[0]?.on).toBe(true);
  });

  it("picks up a tracking table an earlier runner filled, with no data migration", async () => {
    await db.query(`CREATE SCHEMA app;
      CREATE TABLE app."schema_migrations" ("version" TEXT PRIMARY KEY, "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now());
      INSERT INTO app."schema_migrations" ("version") VALUES ('1_a');`);
    const run = await migrate(await folder({ "1_a.sql": "SELECT nope;", "2_b.sql": "SELECT 1;" }));
    expect(run.exitCode).toBe(0);
    expect(run.applied).toEqual(["2_b.sql"]);
  });

  it("rolls a failing file back whole, names it with a line number, and stops", async () => {
    const dir = await folder({
      "1_a.sql": "CREATE TABLE public.one (x int);",
      "2_b.sql": "CREATE TABLE public.two (x int);\n\nSELECT nope;",
      "3_c.sql": "CREATE TABLE public.three (x int);",
    });
    const run = await migrate(dir);
    expect(run.exitCode).toBe(1);
    expect(run.applied).toEqual(["1_a.sql"]);
    expect(await exists("public.two")).toBe(false);
    expect(await exists("public.three")).toBe(false);
    expect(await versions()).toEqual(["1_a"]);
    expect(run.log.text()).toContain(
      '✗ Failed to apply 2_b.sql: column "nope" does not exist (line 3)',
    );
    expect(run.log.text()).toContain("1 later migration(s) not attempted: 3_c.sql");
    // One failure, reported once.
    expect(run.log.lines.filter((line) => line.includes("does not exist"))).toHaveLength(1);
    expect(run.log.text()).not.toContain("Fatal");
  });

  it("runs a no-transaction file one statement at a time, so CONCURRENTLY works", async () => {
    const dir = await folder({
      "1_a.sql": "CREATE TABLE public.t (x int, y int);",
      "2_b.sql":
        "-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY t_x ON public.t (x);\nCREATE INDEX CONCURRENTLY t_y ON public.t (y);\n",
    });
    const run = await migrate(dir);
    expect(run.log.text()).not.toContain("Failed");
    expect(run.exitCode).toBe(0);
    expect(await exists("public.t_x")).toBe(true);
    expect(await exists("public.t_y")).toBe(true);
    expect(await versions()).toEqual(["1_a", "2_b"]);
  });

  it("says what stays applied when a no-transaction file fails partway", async () => {
    const dir = await folder({
      "1_a.sql": "-- migrate: no-transaction\nCREATE TABLE public.kept (x int);\nSELECT nope;\n",
    });
    const run = await migrate(dir);
    expect(run.exitCode).toBe(1);
    expect(await exists("public.kept")).toBe(true);
    expect(run.log.text()).toContain("the statements before the failure are still applied");
  });

  it("starts every file from the session's startup settings", async () => {
    // A pg_dump baseline empties search_path for the whole session. Without a reset between
    // files, the next unqualified name fails in a replay and never in a deploy.
    const baseline =
      "CREATE SCHEMA IF NOT EXISTS app;\nSELECT pg_catalog.set_config('search_path', '', false);\nSET check_function_bodies = false;\nCREATE TABLE app.t (x int);";
    const run = await migrate(
      await folder({ "1_a.sql": baseline, "2_b.sql": "INSERT INTO t VALUES (1);" }),
      {
        searchPath: "app",
      },
    );
    expect(run.log.text()).not.toContain("Failed");
    expect(run.exitCode).toBe(0);
  });

  it("checks function bodies in every file, even after a baseline turned the check off", async () => {
    const dir = await folder({
      "1_a.sql": "SET check_function_bodies = false;\nCREATE TABLE public.t (x int);",
      "2_b.sql":
        "CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT x FROM public.missing $$;",
    });
    const run = await migrate(dir);
    expect(run.exitCode).toBe(1);
    expect(run.log.text()).toContain('relation "public.missing" does not exist');
  });

  it("refuses a bad directive before anything applies", async () => {
    const dir = await folder({
      "1_a.sql": "CREATE TABLE public.t (x int);",
      "2_b.sql": "-- @manual\nSELECT 1;",
    });
    const run = await migrate(dir);
    expect(run.exitCode).toBe(1);
    expect(run.log.text()).toContain('2_b.sql, line 1: "-- @manual" is no longer read');
    expect(await exists("public.t")).toBe(false);
  });

  it("calls a missing folder an error, not an empty one", async () => {
    const run = await migrate(join(await folder({}), "migrationz"));
    expect(run.exitCode).toBe(1);
    expect(run.log.text()).toContain("No migrations folder at");
  });

  it("does nothing, successfully, for an empty folder", async () => {
    const run = await migrate(await folder({}));
    expect(run.exitCode).toBe(0);
    expect(run.log.text()).toContain("No .sql files in");
    expect(await schemaExists("app")).toBe(false);
  });

  it("needs DATABASE_URL", async () => {
    const run = await migrate(await folder({ "1_a.sql": "SELECT 1;" }), { databaseUrl: undefined });
    expect(run.exitCode).toBe(1);
    expect(run.log.text()).toContain("DATABASE_URL is not set");
  });

  it("names the failing file when the connection drops mid-file", async () => {
    const dir = await folder({
      "1_a.sql": "SELECT 1;",
      "2_b.sql": "SELECT pg_sleep(30);",
      "3_c.sql": "SELECT 1;",
    });
    const running = migrate(dir);
    const killer = new Client({ connectionString: db.url });
    await killer.connect();
    try {
      for (let tries = 0; tries < 100; tries++) {
        const { rowCount } = await killer.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
            WHERE application_name = '@gusnips/migrate' AND query LIKE 'SELECT pg_sleep(30)%'`,
        );
        if (rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      await killer.end();
    }
    const run = await running;
    expect(run.exitCode).toBe(1);
    expect(run.log.text()).toMatch(/✗ Failed to apply 2_b\.sql: .*terminat/i);
    expect(run.log.text()).toContain("not attempted: 3_c.sql");
  });
});

describe("gated files", () => {
  const files = {
    "1_a.sql": "CREATE TABLE public.one (x int);",
    "2_b.sql": "-- migrate: manual waits for a drain\nCREATE TABLE public.two (x int);",
    "3_c.sql": "CREATE TABLE public.three (x int);",
  };

  it("holds a gated file, applies the later ones, and says so in the line workflows grep", async () => {
    const run = await migrate(await folder(files));
    expect(run.exitCode).toBe(0);
    expect(run.applied).toEqual(["1_a.sql", "3_c.sql"]);
    expect(run.held).toEqual(["2_b.sql"]);
    expect(run.log.lines).toContain("[MIGRATIONS] MANUAL_PENDING 2_b.sql — waits for a drain");
    expect(run.log.text()).not.toContain("Nothing to do");
    // The hint names no command: the runner cannot know the adopter's, and a wrong one on the box
    // (one that also regenerates a source file) is worse than none.
    expect(run.log.text()).toContain("run the same command again with --manual");
    expect(run.log.text()).not.toMatch(/bun (run )?migrate/);
  });

  it("never says 'nothing to do' while a gated file waits", async () => {
    const dir = await folder(files);
    await migrate(dir);
    const again = await migrate(dir);
    expect(again.exitCode).toBe(0);
    expect(again.held).toEqual(["2_b.sql"]);
    expect(again.log.text()).not.toContain("Nothing to do");
    expect(again.log.lines).toContain("[MIGRATIONS] MANUAL_PENDING 2_b.sql — waits for a drain");
  });

  it("counts only the files this run applies", async () => {
    const dir = await folder({ ...files, "4_d.sql": "SELECT 1;" });
    const run = await migrate(dir);
    expect(run.log.text()).toContain("Applying 3_c.sql (2 of 3)");
    expect(run.log.text()).toContain("Applying 4_d.sql (3 of 3)");
  });

  it("applies a gated file in order with --manual --yes", async () => {
    const run = await migrate(await folder(files), { manual: true, yes: true });
    expect(run.exitCode).toBe(0);
    expect(run.applied).toEqual(["1_a.sql", "2_b.sql", "3_c.sql"]);
    expect(await versions()).toEqual(["1_a", "2_b", "3_c"]);
  });

  it("refuses --manual without a terminal to ask on, before changing anything", async () => {
    const log = captureLog();
    // No `confirm`: the default, which finds no TTY under the test runner.
    const run = await runMigrations({
      dir: await folder(files),
      databaseUrl: db.url,
      manual: true,
      log,
    });
    expect(run.exitCode).toBe(1);
    expect(log.text()).toContain("--manual needs a terminal to confirm 2_b.sql");
    expect(log.text()).toContain("--manual --yes");
    expect(await exists("public.one")).toBe(false);
  });

  it("asks before taking the lock, and holds a file the answer declines", async () => {
    const watcher = new Client({ connectionString: db.url });
    await watcher.connect();
    const locksWhileAsking: number[] = [];
    try {
      const run = await migrate(await folder(files), {
        manual: true,
        confirm: async () => {
          const { rows } = await watcher.query<{ n: number }>(
            "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'",
          );
          locksWhileAsking.push(rows[0]?.n ?? -1);
          return false;
        },
      });
      expect(locksWhileAsking).toEqual([0]);
      expect(run.exitCode).toBe(0);
      expect(run.applied).toEqual(["1_a.sql", "3_c.sql"]);
      expect(run.held).toEqual(["2_b.sql"]);
    } finally {
      await watcher.end();
    }
  });
});

describe("the lock", () => {
  it("is taken before any DDL, and a bounded wait names who holds it", async () => {
    const holder = await holdLock();
    try {
      const run = await migrate(await folder({ "1_a.sql": "SELECT 1;" }), { lockWaitSeconds: 1 });
      expect(run.exitCode).toBe(1);
      expect(run.log.text()).toMatch(
        /Waited 1s for the migration lock, and session \d+, lock-holder/,
      );
      // Nothing ran before the lock: not even the tracking table.
      expect(await schemaExists("app")).toBe(false);
    } finally {
      await holder.release();
    }
  });

  it("makes a second run wait, then skip what the first one applied", async () => {
    const holder = await holdLock();
    const dir = await folder({
      "1_a.sql": "CREATE TABLE public.once (x int);",
      "2_b.sql": "SELECT 1;",
    });
    const waiting = migrate(dir, { lockWaitSeconds: 10 });
    // Only once the second run is really waiting on the lock, or it would plan after the first.
    for (let tries = 0; tries < 200; tries++) {
      const { rowCount } = await holder.client.query(
        "SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
      );
      if (rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    // Play the first run: it applies 1_a, then ends its session.
    await holder.client.query(`CREATE SCHEMA app;
      CREATE TABLE app."schema_migrations" ("version" TEXT PRIMARY KEY, "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE public.once (x int);
      INSERT INTO app."schema_migrations" ("version") VALUES ('1_a');`);
    await holder.release();
    const run = await waiting;
    expect(run.exitCode).toBe(0);
    expect(run.applied).toEqual(["2_b.sql"]);
    expect(run.log.text()).toContain("Another run holds the migration lock");
    expect(run.log.text()).toContain(
      "1 file(s) were applied by another run while this one waited.",
    );
  });

  it("uses the key it is given", async () => {
    const holder = await holdLock(42);
    try {
      const run = await migrate(await folder({ "1_a.sql": "SELECT 1;" }), {
        lockKey: 42,
        lockWaitSeconds: 1,
      });
      expect(run.exitCode).toBe(1);
    } finally {
      await holder.release();
    }
    expect(
      (await migrate(await folder({ "1_a.sql": "SELECT 1;" }), { lockWaitSeconds: 1 })).exitCode,
    ).toBe(0);
  });
});

describe("--status", () => {
  const files = {
    "1_a.sql": "CREATE TABLE public.one (x int);",
    "2_b.sql": "-- migrate: manual\nSELECT 1;",
    "3_c.sql": "SELECT 1;",
  };

  it("reports without writing: no schema, no table, no lock", async () => {
    const holder = await holdLock();
    try {
      const run = await migrate(await folder(files), { status: true, lockWaitSeconds: 1 });
      expect(run.exitCode).toBe(0);
      expect(run.log.lines).toContain("[MIGRATIONS] Status: PENDING 2: 1_a.sql, 3_c.sql");
      expect(run.log.text()).toContain("Held until a run with --manual: 2_b.sql");
      expect(run.pending).toEqual(["1_a.sql", "3_c.sql"]);
      expect(await schemaExists("app")).toBe(false);
    } finally {
      await holder.release();
    }
  });

  it("says up to date, and lists versions that were applied but have no file", async () => {
    const dir = await folder(files);
    await migrate(dir);
    await db.query(`INSERT INTO app."schema_migrations" ("version") VALUES ('0_hand_applied')`);
    const run = await migrate(dir, { status: true });
    expect(run.log.lines).toContain("[MIGRATIONS] Status: up to date (2 applied).");
    expect(run.appliedWithoutFile).toEqual(["0_hand_applied"]);
    expect(run.log.text()).toContain(
      "Recorded as applied, but no file in the folder: 0_hand_applied",
    );
  });

  it("fails loudly when it cannot reach the database, so a dead check never reads as up to date", async () => {
    const run = await migrate(await folder(files), {
      status: true,
      databaseUrl: "postgresql://postgres@127.0.0.1:1/nothing",
    });
    expect(run.exitCode).toBe(1);
    expect(run.log.text()).not.toContain("Status:");
    expect(run.log.text()).toContain("Could not connect to 127.0.0.1:1/nothing");
  });
});

describe("the target guard", () => {
  const port = () => Number(new URL(db.url).port) || 5432;

  it("refuses the tunnel port without --yes, before anything applies", async () => {
    const run = await migrate(await folder({ "1_a.sql": "CREATE TABLE public.one (x int);" }), {
      tunnelPort: port(),
    });
    expect(run.exitCode).toBe(1);
    expect(run.log.text()).toContain(
      `Refusing to apply 1 migration(s) to the SSH tunnel on port ${String(port())}`,
    );
    expect(await exists("public.one")).toBe(false);

    const confirmed = await migrate(
      await folder({ "1_a.sql": "CREATE TABLE public.one (x int);" }),
      {
        tunnelPort: port(),
        yes: true,
      },
    );
    expect(confirmed.exitCode).toBe(0);
  });

  it("does not refuse a run that would only hold a gated file", async () => {
    const run = await migrate(await folder({ "1_a.sql": "-- migrate: manual\nSELECT 1;" }), {
      tunnelPort: port(),
    });
    expect(run.exitCode).toBe(0);
    expect(run.held).toEqual(["1_a.sql"]);
  });

  it("does not ask for a no-op run", async () => {
    const dir = await folder({ "1_a.sql": "SELECT 1;" });
    await migrate(dir);
    expect((await migrate(dir, { tunnelPort: port() })).exitCode).toBe(0);
  });

  it("reads a host from the query string rather than calling it remote", async () => {
    const url = `postgresql:///${db.name}?host=127.0.0.1&port=${String(port())}&user=postgres`;
    const run = await migrate(await folder({ "1_a.sql": "SELECT 1;" }), { databaseUrl: url });
    expect(run.log.text()).not.toContain("Refusing");
    expect(run.exitCode).toBe(0);
  });
});

describe("after a run", () => {
  it("runs the types command only when a file applied", async () => {
    const dir = await folder({ "1_a.sql": "SELECT 1;" });
    const marks = join(dir, "types-ran.txt");
    const typesCommand = `echo ran >> "${marks}"`;
    expect((await migrate(dir, { types: true, typesCommand })).exitCode).toBe(0);
    expect((await migrate(dir, { types: true, typesCommand })).exitCode).toBe(0);
    expect(await readFile(marks, "utf8")).toBe("ran\n");
  });

  it("does not run the types command unless asked", async () => {
    const dir = await folder({ "1_a.sql": "SELECT 1;" });
    const marks = join(dir, "types-ran.txt");
    await migrate(dir, { typesCommand: `echo ran >> "${marks}"` });
    await expect(readFile(marks, "utf8")).rejects.toThrow();
  });

  it("refuses --types with no command, and fails when the command fails", async () => {
    const dir = await folder({ "1_a.sql": "SELECT 1;" });
    const bare = await migrate(dir, { types: true });
    expect(bare.exitCode).toBe(1);
    expect(bare.log.text()).toContain("no types command is set");
    expect(await schemaExists("app")).toBe(false);

    const broken = await migrate(dir, { types: true, typesCommand: "exit 3" });
    expect(broken.exitCode).toBe(1);
    expect(broken.applied).toEqual(["1_a.sql"]);
    expect(broken.log.text()).toContain(
      "The types command exited with 3. The migrations are applied",
    );
  });

  it("runs the inspect hook after --status and after applying, not after a no-op", async () => {
    const dir = await folder({ "1_a.sql": "SELECT 1;" });
    const calls: string[] = [];
    const inspect = async (client: Client) => {
      const { rows } = await client.query<{ n: number }>("SELECT 1 AS n");
      calls.push(String(rows[0]?.n));
    };
    await migrate(dir, { status: true, inspect });
    await migrate(dir, { inspect });
    await migrate(dir, { inspect });
    expect(calls).toEqual(["1", "1"]);
  });
});

describe("unreadableTablesCheck", () => {
  it("warns about tables service_role cannot read, and passes the ones it can", async () => {
    await db.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN;
        END IF;
      END $$;`);
    const dir = await folder({
      "1_a.sql":
        "CREATE TABLE public.forgotten (x int);\nCREATE TABLE public.granted (x int);\nGRANT SELECT ON public.granted TO service_role;",
    });
    const run = await migrate(dir, { inspect: unreadableTablesCheck("public") });
    expect(run.exitCode).toBe(0);
    expect(run.log.text()).toContain(
      '⚠ 1 table(s) in "public" that service_role cannot read: forgotten.',
    );
    expect(run.log.text()).toContain(
      "GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;",
    );
  });
});

// Keeps the helper honest: a URL built for another database really points there.
it("builds per-test URLs on the admin URL", () => {
  expect(urlFor("x")).toMatch(/\/x$/);
});
