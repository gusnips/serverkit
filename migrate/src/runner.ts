/**
 * The migration runner: plain `.sql` files, applied in order, one transaction each.
 *
 * It replaces eleven hand-written runners that had drifted into three behaviours, and each rule
 * below is here because one of those copies got it wrong in a way the others had already fixed.
 * The long reasons are in AGENTS.md; the short ones sit next to the code they explain.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { describeError } from "./errors.ts";
import { readMigrationFiles, type MigrationFile } from "./files.ts";
import { LOG_PREFIX, manualPendingLine, statusPendingLine, STATUS_UP_TO_DATE } from "./lines.ts";
import { pgSsl } from "./ssl.ts";
import { confirmationReason, describeTarget } from "./target.ts";

/** The advisory lock key a run takes unless told otherwise. Locks are per database. */
export const DEFAULT_LOCK_KEY = 727_001_001;

/** How long a run waits for another run to finish before it gives up. */
export const DEFAULT_LOCK_WAIT_SECONDS = 120;

export interface Log {
  info(line: string): void;
  error(line: string): void;
}

export interface MigrateOptions {
  /** The folder holding the `.sql` files. A `file:` URL works too: `new URL("../migrations", import.meta.url)`. */
  dir: string | URL;
  databaseUrl: string | undefined;
  /** The schema that holds `schema_migrations`. Default `app`. */
  schema?: string;
  /**
   * Sets `search_path` for the whole connection, as a startup value. Files that use unqualified
   * names need it. It survives the `RESET ALL` the runner sends before each file, and a
   * `set_config('search_path', '', false)` inside a pg_dump baseline does not.
   */
  searchPath?: string;
  /** A loopback port that an SSH tunnel forwards to a remote database. Applying there needs `--yes`. */
  tunnelPort?: number;
  /** A shell command that regenerates database types. `types: true` runs it after a run that applied a file. */
  typesCommand?: string;
  /** Turn on row level security for `schema_migrations`, for schemas where every table must have it. */
  rlsOnTrackingTable?: boolean;
  lockKey?: number;
  lockWaitSeconds?: number;

  /** `--manual`: also apply files marked `-- migrate: manual`, asking first unless `yes`. */
  manual?: boolean;
  /** `--yes`: skip the questions `manual` asks, and confirm a remote target. */
  yes?: boolean;
  /** `--status`: report what a run would do, and change nothing. */
  status?: boolean;
  /** `--types`: run `typesCommand` after a run that applied at least one file. */
  types?: boolean;

  /**
   * Runs after `--status`, and after a run that applied at least one file, on the same
   * connection. For read-only checks of the database's state; see `unreadableTablesCheck`.
   */
  inspect?: (client: Client, log: Log) => Promise<void>;
  /**
   * Asks whether to apply a gated file. The default asks on the terminal, and there is none when
   * stdin is not a TTY: then a `--manual` run without `--yes` refuses rather than guessing.
   */
  confirm?: ((file: MigrationFile) => Promise<boolean>) | null;
  log?: Log;
}

export interface MigrateResult {
  /** 0 when the run did what it was asked, holding a gated file included. 1 otherwise. */
  exitCode: 0 | 1;
  /** Files this run applied. */
  applied: string[];
  /** Gated files left for a run with `--manual`. */
  held: string[];
  /** Files a run would apply. After a normal run, only those a failure stopped. */
  pending: string[];
  /** Versions recorded as applied that have no file in the folder. Filled by `--status`. */
  appliedWithoutFile: string[];
}

const consoleLog: Log = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runMigrations(options: MigrateOptions): Promise<MigrateResult> {
  const log = options.log ?? consoleLog;
  const say = (line: string) => log.info(`${LOG_PREFIX} ${line}`);
  const shout = (line: string) => log.error(`${LOG_PREFIX} ${line}`);
  const result: MigrateResult = {
    exitCode: 0,
    applied: [],
    held: [],
    pending: [],
    appliedWithoutFile: [],
  };
  const fail = (...lines: string[]): MigrateResult => {
    for (const line of lines) shout(line);
    return { ...result, exitCode: 1 };
  };

  const schema = options.schema ?? "app";
  const table = `${quoteIdent(schema)}."schema_migrations"`;
  const dir = typeof options.dir === "string" ? options.dir : fileURLToPath(options.dir);
  const databaseUrl = options.databaseUrl;

  if (!databaseUrl)
    return fail("DATABASE_URL is not set. Point it at the database you want to migrate.");
  if (options.types && !options.typesCommand && !options.status)
    return fail(
      "--types was given, but no types command is set. Pass typesCommand (or --types-command).",
    );

  let files: MigrationFile[];
  try {
    files = await readMigrationFiles(dir);
  } catch (err) {
    return fail(...describeError(err));
  }

  const target = describeTarget(databaseUrl);
  const where = target ? `${target.host}:${String(target.port)}/${target.database}` : "database";
  const client = new Client({
    connectionString: databaseUrl,
    ...pgSsl(databaseUrl),
    application_name: "@gusnips/migrate",
    ...(options.searchPath
      ? { options: `-c search_path=${escapeOption(options.searchPath)}` }
      : {}),
  });
  // Without a listener, a dropped connection kills the process from inside pg's socket handler:
  // pg defers the failed query's rejection to the next tick and emits `error` synchronously, and
  // an EventEmitter with no `error` listener throws. The process then dies before the line that
  // names the failing file can print. With one, the query rejects and the file gets named.
  let connectionError: Error | undefined;
  client.on("error", (err) => {
    connectionError = err;
  });

  let ranTypes = false;
  try {
    try {
      await client.connect();
    } catch (err) {
      return fail(
        `Could not connect to ${where}: ${describeError(err).join(" ")}`,
        "Check that Postgres is running and that DATABASE_URL is right.",
      );
    }
    say(`Connected to ${where}.`);

    // Read-only until the lock is held: the tracking table may not exist yet.
    const appliedBefore = await readAppliedVersions(client, table);
    const plan = planRun(files, appliedBefore, options.manual === true);

    if (options.status) {
      const known = new Set(files.map((file) => file.version));
      result.pending = plan.toApply.map((file) => file.file);
      result.held = plan.held.map((file) => file.file);
      result.appliedWithoutFile = [...appliedBefore].filter((version) => !known.has(version));

      say(`Applied: ${String(plan.alreadyApplied)} of ${String(files.length)} file(s).`);
      log.info(
        result.pending.length > 0
          ? statusPendingLine(result.pending)
          : `${STATUS_UP_TO_DATE} (${String(plan.alreadyApplied)} applied).`,
      );
      if (result.held.length > 0) say(`Held until a run with --manual: ${result.held.join(", ")}`);
      if (result.appliedWithoutFile.length > 0)
        say(
          `Recorded as applied, but no file in the folder: ${result.appliedWithoutFile.join(", ")}`,
        );
      await options.inspect?.(client, log);
      return result;
    }

    if (files.length === 0) {
      say(`No .sql files in ${dir}. Nothing to do.`);
      return result;
    }

    // The guard counts only what this run would apply. A gated file it is about to hold changes
    // nothing, so it is no reason to refuse.
    if (plan.toApply.length > 0) {
      const reason = target
        ? confirmationReason(target, { tunnelPort: options.tunnelPort })
        : "a DATABASE_URL the runner cannot read a host from";
      if (reason && !options.yes)
        return fail(
          `Refusing to apply ${String(plan.toApply.length)} migration(s) to ${reason}.`,
          "If that is what you want, run again with --yes or MIGRATE_CONFIRM=1.",
        );
      if (reason) say(`--yes given: applying to ${reason}.`);
    }

    // Ask before the lock, never while holding it. A question nobody answers must not leave the
    // next deploy waiting on a lock forever.
    const gated = plan.toApply.filter((file) => file.manual);
    if (gated.length > 0 && !options.yes) {
      const confirm = options.confirm === undefined ? terminalConfirm() : options.confirm;
      if (!confirm)
        return fail(
          `--manual needs a terminal to confirm ${gated.map((file) => file.file).join(", ")}, and this run has none.`,
          "If you mean to apply them, run again with --manual --yes.",
        );
      for (const file of gated) {
        if (await confirm(file)) continue;
        plan.toApply = plan.toApply.filter((candidate) => candidate !== file);
        plan.held.push(file);
        say(`Holding ${file.file}: not confirmed.`);
      }
      plan.held.sort((a, b) => files.indexOf(a) - files.indexOf(b));
    }

    result.held = plan.held.map((file) => file.file);
    for (const file of plan.held) log.info(manualPendingLine(file.file, file.reason));

    if (plan.toApply.length > 0) {
      await acquireLock(client, {
        key: options.lockKey ?? DEFAULT_LOCK_KEY,
        waitSeconds: options.lockWaitSeconds ?? DEFAULT_LOCK_WAIT_SECONDS,
        say,
      });

      // The tracking table is created under the lock. Two runners creating it at once on an
      // empty database can fail on the catalog's unique index.
      if (!(await tableExists(client, table))) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
        await client.query(`
          CREATE TABLE IF NOT EXISTS ${table} (
            "version" TEXT PRIMARY KEY,
            "applied_at" TIMESTAMPTZ NOT NULL DEFAULT now()
          )
        `);
      }
      if (options.rlsOnTrackingTable)
        await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);

      // Another run may have applied some of these while this one waited for the lock.
      const appliedNow = await readAppliedVersions(client, table);
      const before = plan.toApply.length;
      plan.toApply = plan.toApply.filter((file) => !appliedNow.has(file.version));
      if (plan.toApply.length < before)
        say(
          `${String(before - plan.toApply.length)} file(s) were applied by another run while this one waited.`,
        );
    }

    for (const [index, file] of plan.toApply.entries()) {
      say(
        `Applying ${file.file} (${String(index + 1)} of ${String(plan.toApply.length)})` +
          `${file.noTransaction ? ", without a transaction" : ""}...`,
      );
      try {
        await applyFile(client, table, file);
      } catch (err) {
        const lines = describeError(err, file.noTransaction ? undefined : file.sql);
        if (connectionError && connectionError.message !== lines[0])
          lines.push(`The connection closed: ${connectionError.message}`);
        shout(`✗ Failed to apply ${file.file}: ${lines.join("\n  ")}`);
        if (file.noTransaction)
          shout(
            "  It ran without a transaction, so the statements before the failure are still applied. Check the database before you run it again.",
          );
        const notAttempted = plan.toApply.slice(index + 1).map((later) => later.file);
        if (notAttempted.length > 0)
          shout(
            `${String(notAttempted.length)} later migration(s) not attempted: ${notAttempted.join(", ")}`,
          );
        result.pending = plan.toApply.slice(index).map((pending) => pending.file);
        return { ...result, exitCode: 1 };
      }
      result.applied.push(file.file);
      say(`✓ Applied ${file.file}.`);
    }

    if (result.applied.length > 0)
      say(
        `Done. Applied ${String(result.applied.length)} migration(s); ${String(plan.alreadyApplied)} were already applied.`,
      );
    if (result.held.length > 0)
      say(
        `${String(result.held.length)} gated migration(s) held: ${result.held.join(", ")}. ` +
          "To apply them, run the same command again with --manual (add --yes where nobody can answer a question).",
      );
    // Only when nothing is waiting. "Nothing to do" above a held file reads as "all clear".
    if (result.applied.length === 0 && result.held.length === 0)
      say("All migrations already applied. Nothing to do.");

    if (result.applied.length > 0) await options.inspect?.(client, log);
    ranTypes = options.types === true && result.applied.length > 0;
  } catch (err) {
    const lines = describeError(err);
    if (connectionError && connectionError.message !== lines[0])
      lines.push(`The connection closed: ${connectionError.message}`);
    return fail(`Fatal error: ${lines.join("\n  ")}`);
  } finally {
    // Ends the session, which also releases the advisory lock.
    await client.end().catch(() => undefined);
  }

  // After the connection is closed, so the types command never waits on this run's lock. Only
  // when the schema moved: a no-op run must never rewrite a source file.
  if (ranTypes && options.typesCommand) {
    say(`Regenerating database types: ${options.typesCommand}`);
    const code = await runShell(options.typesCommand);
    if (code !== 0)
      return fail(
        `The types command exited with ${String(code)}. The migrations are applied; run \`${options.typesCommand}\` by hand.`,
      );
  }
  return result;
}

interface Plan {
  toApply: MigrationFile[];
  held: MigrationFile[];
  alreadyApplied: number;
}

/**
 * A gated file is held and later files still apply. Halting at it instead would turn every
 * contract migration that waits weeks for its precondition into a schema freeze. A later file that
 * needs a held one fails loudly, in its own transaction, and replays run with `--manual --yes` so
 * they apply every file in order.
 */
function planRun(
  files: readonly MigrationFile[],
  applied: ReadonlySet<string>,
  includeManual: boolean,
): Plan {
  const plan: Plan = { toApply: [], held: [], alreadyApplied: 0 };
  for (const file of files) {
    if (applied.has(file.version)) plan.alreadyApplied++;
    else if (file.manual && !includeManual) plan.held.push(file);
    else plan.toApply.push(file);
  }
  return plan;
}

async function applyFile(client: Client, table: string, file: MigrationFile): Promise<void> {
  // Every file starts from the session's startup settings. A pg_dump baseline runs
  // `set_config('search_path', '', false)` and `SET check_function_bodies = false`, and both
  // outlive its transaction. A deploy applies one new file per session, so production never saw
  // the leak; a replay from an empty database applies every file in one session, where the next
  // unqualified name failed and every later function body went unchecked. `RESET ALL`, not
  // `DISCARD ALL`: DISCARD also releases the advisory lock.
  await client.query("RESET ALL");
  const record = () => client.query(`INSERT INTO ${table} ("version") VALUES ($1)`, [file.version]);

  if (file.noTransaction) {
    for (const statement of file.statements) await client.query(statement);
    await record();
    return;
  }

  await client.query("BEGIN");
  try {
    await client.query(file.sql);
    await record();
    await client.query("COMMIT");
  } catch (err) {
    // On a dead connection ROLLBACK fails too. The first error is the one worth reporting.
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  }
}

async function readAppliedVersions(client: Client, table: string): Promise<Set<string>> {
  if (!(await tableExists(client, table))) return new Set();
  const { rows } = await client.query<{ version: string }>(`SELECT "version" FROM ${table}`);
  return new Set(rows.map((row) => row.version));
}

async function tableExists(client: Client, table: string): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [table],
  );
  return rows[0]?.exists === true;
}

/**
 * Take the session advisory lock before any DDL, and wait for it only so long.
 *
 * Session-scoped, so it goes away when the connection closes, crash included. The wait is bounded
 * with `lock_timeout`, which applies to advisory locks (measured), and the message names the
 * session holding it, so a stuck deploy says what it is stuck behind.
 */
async function acquireLock(
  client: Client,
  { key, waitSeconds, say }: { key: number; waitSeconds: number; say: (line: string) => void },
): Promise<void> {
  const { rows } = await client.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock($1::bigint) AS locked",
    [key],
  );
  if (rows[0]?.locked) return;

  const holder = await lockHolder(client, key);
  say(`Another run holds the migration lock (${holder}). Waiting up to ${String(waitSeconds)}s.`);
  await client.query(`SET lock_timeout = '${String(Math.max(1, Math.round(waitSeconds)))}s'`);
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [key]);
  } catch (err) {
    if (err instanceof Error && Reflect.get(err, "code") === "55P03")
      throw new Error(
        `Waited ${String(waitSeconds)}s for the migration lock, and ${holder} still holds it. ` +
          "If that run is stuck, end it, then run this again.",
        { cause: err },
      );
    throw err;
  } finally {
    await client.query("RESET lock_timeout");
  }
}

async function lockHolder(client: Client, key: number): Promise<string> {
  const { rows } = await client.query<{ pid: number; app: string; since: string }>(
    `SELECT a.pid, a.application_name AS app, to_char(a.backend_start, 'YYYY-MM-DD HH24:MI:SS TZ') AS since
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
        AND ((l.classid::bigint << 32) | l.objid::bigint) = $1::bigint
      LIMIT 1`,
    [key],
  );
  const row = rows[0];
  if (!row) return "another session";
  return `session ${String(row.pid)}${row.app ? `, ${row.app}` : ""}, connected since ${row.since}`;
}

/** The default `confirm`: a question on the terminal, or null when there is no terminal. */
function terminalConfirm(): ((file: MigrationFile) => Promise<boolean>) | null {
  if (!process.stdin.isTTY) return null;
  return async (file) => {
    const why = file.reason ? ` (${file.reason})` : "";
    const risk = file.noTransaction
      ? " It runs without a transaction: if it fails partway, what ran stays applied."
      : "";
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = await rl.question(
        `${LOG_PREFIX} ${file.file} is gated${why}.${risk} Apply it now? [y/N] `,
      );
      return ["y", "yes"].includes(answer.trim().toLowerCase());
    } finally {
      rl.close();
    }
  };
}

function runShell(command: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: "inherit" });
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** libpq's `options` string splits on spaces; a backslash keeps one inside a value. */
function escapeOption(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/ /g, "\\ ");
}
