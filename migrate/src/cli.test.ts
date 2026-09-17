import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  // Plain node, no Bun: nothing in the package may lean on a Bun-only global, and the runner must
  // not need anything from an app's environment beyond DATABASE_URL.
  it("runs under node with only DATABASE_URL set", async () => {
    const bin = fileURLToPath(new URL("./bin/migrate.ts", import.meta.url));
    const { stdout } = await promisify(execFile)(
      "node",
      ["--experimental-strip-types", "--no-warnings", bin, "--dir", dir],
      { env: { PATH: process.env.PATH ?? "", DATABASE_URL: db.url } },
    );
    expect(stdout).toContain("✓ Applied 1_a.sql.");
    expect(await applied()).toBe(true);
  });
});
