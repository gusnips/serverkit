import { execFile } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateCli } from "./cli.ts";
import {
  captureLog,
  freshDatabase,
  migrationsDir,
  removeDir,
  type TestDatabase,
} from "./test/db.ts";

let db: TestDatabase;
let dir: string;

beforeEach(async () => {
  db = await freshDatabase();
  dir = await migrationsDir({ "1_a.sql": "CREATE TABLE public.one (x int);" });
});

afterEach(async () => {
  await db.drop();
  await removeDir(dir);
});

const applied = async () =>
  (await db.query<{ found: boolean }>("SELECT to_regclass('public.one') IS NOT NULL AS found"))[0]
    ?.found;

async function cli(argv: string[], env: Record<string, string> = {}) {
  const log = captureLog();
  const code = await migrateCli({ dir }, argv, { DATABASE_URL: db.url, ...env }, log);
  return { code, log };
}

describe("migrateCli", () => {
  it("refuses an unknown flag, names it, and applies nothing", async () => {
    // Every earlier runner ignored unknown flags, so `migrate --dry-run` applied everything.
    const { code, log } = await cli(["--dry-run"]);
    expect(code).toBe(1);
    expect(log.lines[0]).toBe('[MIGRATIONS] Unknown flag "--dry-run".');
    expect(await applied()).toBe(false);
  });

  it("refuses a stray argument and a value on a switch", async () => {
    expect((await cli(["status"])).log.lines[0]).toBe('[MIGRATIONS] Unexpected argument "status".');
    expect((await cli(["--yes=no"])).log.lines[0]).toContain('--yes takes no value, but got "no"');
    expect((await cli(["--tunnel-port", "abc"])).log.lines[0]).toContain(
      '--tunnel-port must be a port number, but got "abc"',
    );
    expect(await applied()).toBe(false);
  });

  it("maps --status to a read-only report", async () => {
    const { code, log } = await cli(["--status"]);
    expect(code).toBe(0);
    expect(log.lines).toContain("[MIGRATIONS] Status: PENDING 1: 1_a.sql");
    expect(await applied()).toBe(false);
  });

  it("accepts --yes, -y and MIGRATE_CONFIRM=1 alike", async () => {
    const port = new URL(db.url).port;
    expect((await cli(["--tunnel-port", port])).code).toBe(1);
    for (const [argv, env] of [
      [["--tunnel-port", port, "--yes"], {}],
      [["--tunnel-port", port, "-y"], {}],
      [["--tunnel-port", port], { MIGRATE_CONFIRM: "1" }],
    ] as const) {
      const run = await cli([...argv], env);
      expect(run.code, `${argv.join(" ")} ${JSON.stringify(env)}`).toBe(0);
      await db.query("DROP SCHEMA IF EXISTS app CASCADE; DROP TABLE IF EXISTS public.one;");
    }
  });

  it("reads MIGRATE_CONFIRM as a yes only when it is 1", async () => {
    // A `MIGRATE_CONFIRM=0` left in a shell is somebody saying no, not a truthy string.
    const port = new URL(db.url).port;
    for (const value of ["0", "", "true"])
      expect((await cli(["--tunnel-port", port], { MIGRATE_CONFIRM: value })).code, value).toBe(1);
    expect(await applied()).toBe(false);
  });

  it("takes the folder as a file URL, the way an adopter's script passes it", async () => {
    const log = captureLog();
    const code = await migrateCli({ dir: pathToFileURL(dir) }, [], { DATABASE_URL: db.url }, log);
    expect(code).toBe(0);
    expect(await applied()).toBe(true);
  });

  it("forwards --manual, --types and --types-command", async () => {
    await removeDir(dir);
    dir = await migrationsDir({
      "1_a.sql": "-- migrate: manual\nCREATE TABLE public.one (x int);",
    });
    const run = await cli(["--manual", "--yes", "--types", "--types-command", "true"]);
    expect(run.code).toBe(0);
    expect(run.log.text()).toContain("Regenerating database types: true");
    expect(await applied()).toBe(true);
  });

  it("ignores a leading -- that a package manager passed through", async () => {
    expect((await cli(["--", "--status"])).code).toBe(0);
    expect(await applied()).toBe(false);
  });
});

describe("the bin", () => {
  const bin = fileURLToPath(new URL("./bin/gusnips-migrate.ts", import.meta.url));
  // Plain node, no Bun: nothing in the package may lean on a Bun-only global, and the runner must
  // not need anything from an app's environment beyond DATABASE_URL.
  const run = async (argv: string[]) => {
    try {
      const { stdout, stderr } = await promisify(execFile)(
        "node",
        ["--experimental-strip-types", "--no-warnings", bin, ...argv],
        { env: { PATH: process.env.PATH ?? "", DATABASE_URL: db.url } },
      );
      return { code: 0, stdout, stderr };
    } catch (err) {
      const failed = err as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  };

  it("runs the runner under node with only DATABASE_URL set", async () => {
    const { code, stdout } = await run(["--dir", dir]);
    expect(code).toBe(0);
    expect(stdout).toContain("✓ Applied 1_a.sql.");
    expect(await applied()).toBe(true);
  });

  it("reads db-types and supabase-stand-in as commands, first thing on the line only", async () => {
    const [types, standIn, late, unknown] = await Promise.all([
      run(["db-types", "--help"]),
      run(["supabase-stand-in", "--help"]),
      run(["--dir", dir, "db-types"]),
      run(["--dir", dir, "--dry-run"]),
    ]);
    expect(types.code).toBe(0);
    expect(types.stdout).toContain("Usage: gusnips-migrate db-types --out <file>");
    expect(standIn.code).toBe(0);
    expect(standIn.stdout).toContain("Usage: gusnips-migrate supabase-stand-in");
    // Anywhere else, a command name is a stray argument and the runner refuses it.
    expect(late.code).toBe(1);
    expect(late.stderr).toContain('[MIGRATIONS] Unexpected argument "db-types".');
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('[MIGRATIONS] Unknown flag "--dry-run".');
    expect(await applied()).toBe(false);
  });
});
