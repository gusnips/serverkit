import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseFlags, stringFlag, type FlagSpec } from "./args.ts";
import { generateTypes, type TypesShape } from "./db-types.ts";
import { describeError } from "./errors.ts";
import type { Log } from "./runner.ts";

const PREFIX = "[DB-TYPES]";

const FLAGS: FlagSpec = {
  out: { type: "string" },
  schema: { type: "string" },
  shape: { type: "string" },
  format: { type: "string" },
  check: { type: "boolean" },
  help: { type: "boolean", short: "h" },
};

export const DB_TYPES_USAGE = `Write TypeScript types for a Postgres schema.

Usage: gusnips-migrate db-types --out <file> [flags]

  --out <file>        Where the types go.
  --schema <name>     The schema to read. Default: app.
  --shape <shape>     supabase (for supabase-js) or rows (for raw pg). Default: supabase.
  --format <command>  A command that reads the file on stdin and prints it formatted, e.g.
                      "prettier --stdin-filepath src/database.types.ts".
  --check             Write nothing. Exit 1 if the file on disk is not what db-types would write.

Reads DATABASE_URL.`;

/**
 * Parse the command line, generate, then write or check. Returns the exit code.
 *
 * `--check` is the drift gate: CI replays the migrations into a throwaway database and fails when
 * the committed types are not what that database produces. It compares after `--format`, because
 * the committed file is the formatted one.
 */
export async function dbTypesCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: Log = { info: (line) => console.log(line), error: (line) => console.error(line) },
): Promise<number> {
  const fail = (...lines: string[]) => {
    for (const line of lines) log.error(`${PREFIX} ${line}`);
    return 1;
  };

  const { flags, error } = parseFlags(argv, FLAGS);
  if (error) return fail(error, "", DB_TYPES_USAGE);
  if (flags.help) {
    log.info(DB_TYPES_USAGE);
    return 0;
  }

  const out = stringFlag(flags, "out");
  if (!out) return fail("No output file. Pass --out <file>.", "", DB_TYPES_USAGE);
  const shape = stringFlag(flags, "shape") ?? "supabase";
  if (shape !== "supabase" && shape !== "rows")
    return fail(`--shape must be supabase or rows, but got "${shape}".`);
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return fail("DATABASE_URL is not set. Point it at the database to read.");
  const schema = stringFlag(flags, "schema") ?? "app";

  let generated;
  try {
    generated = await generateTypes({ databaseUrl, schema, shape: shape satisfies TypesShape });
  } catch (err) {
    return fail(
      `Could not read the \`${schema}\` schema: ${describeError(err).join(" ")}`,
      "Check that Postgres is running and that DATABASE_URL is right.",
    );
  }
  if (generated.tables === 0)
    log.error(
      `${PREFIX} ⚠ The \`${schema}\` schema has no tables this role can see. Is --schema right, and are the migrations applied?`,
    );
  if (generated.unmapped.length > 0)
    log.error(
      `${PREFIX} ⚠ Types with no mapping, typed as string: ${generated.unmapped.join(", ")}`,
    );

  let text = generated.text;
  const format = stringFlag(flags, "format");
  if (format) {
    const formatted = await pipeThrough(format, text);
    if (formatted.code !== 0)
      return fail(
        `The format command exited with ${String(formatted.code)}: ${format}`,
        ...formatted.stderr.trim().split("\n").filter(Boolean),
      );
    text = formatted.stdout;
  }

  const path = resolve(out);
  if (flags.check) {
    const current = await readFile(path, "utf8").catch(() => null);
    if (current === text) {
      log.info(`${PREFIX} ✓ ${out} is up to date.`);
      return 0;
    }
    return fail(
      current === null
        ? `${out} does not exist.`
        : `${out} is out of date: ${firstDifference(current, text)}.`,
      `Regenerate it from a database with every migration applied, and commit the result.`,
    );
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  log.info(
    `${PREFIX} ✓ Wrote ${String(generated.tables)} tables, ${String(generated.views)} views, ` +
      `${String(generated.enums)} enums to ${out}`,
  );
  return 0;
}

function firstDifference(current: string, next: string): string {
  const a = current.split("\n");
  const b = next.split("\n");
  for (let line = 0; line < Math.max(a.length, b.length); line++) {
    if (a[line] !== b[line])
      return `line ${String(line + 1)} is ${JSON.stringify(a[line] ?? "(end of file)")} on disk and ${JSON.stringify(b[line] ?? "(end of file)")} from the database`;
  }
  return "the line endings differ";
}

function pipeThrough(
  command: string,
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (err) => done({ code: 127, stdout, stderr: err.message }));
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(input);
  });
}
