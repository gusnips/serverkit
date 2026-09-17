import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { parseFlags, type FlagSpec } from "./args.ts";
import { describeError } from "./errors.ts";
import type { Log } from "./runner.ts";
import { pgSsl } from "./ssl.ts";
import { describeTarget, isLocalHost } from "./target.ts";

const PREFIX = "[STAND-IN]";

/** The SQL file, shipped in the package. Also importable as `@gusnips/migrate/supabase-stand-in.sql`. */
export const SUPABASE_STAND_IN_PATH = fileURLToPath(
  new URL("../sql/supabase-stand-in.sql", import.meta.url),
);

/** Apply the Supabase stand-in on an open connection. Safe to run twice. */
export async function applySupabaseStandIn(client: Client): Promise<void> {
  await client.query(await readFile(SUPABASE_STAND_IN_PATH, "utf8"));
}

export const STAND_IN_USAGE = `Give a stock Postgres the roles and auth tables a Supabase database starts with, so
migrations written for Supabase can be replayed in CI.

Usage: gusnips-migrate supabase-stand-in

Reads DATABASE_URL, and refuses anything but a database on this machine.`;

const FLAGS: FlagSpec = { help: { type: "boolean", short: "h" } };

export async function standInCli(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: Log = { info: (line) => console.log(line), error: (line) => console.error(line) },
): Promise<number> {
  const fail = (...lines: string[]) => {
    for (const line of lines) log.error(`${PREFIX} ${line}`);
    return 1;
  };

  const { flags, error } = parseFlags(argv, FLAGS);
  if (error) return fail(error, "", STAND_IN_USAGE);
  if (flags.help) {
    log.info(STAND_IN_USAGE);
    return 0;
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) return fail("DATABASE_URL is not set. Point it at a throwaway local database.");
  // A real Supabase database already has all of this, and a real self-hosted one should never get
  // a fake auth schema. There is no --yes: the stand-in is for throwaway databases only.
  const target = describeTarget(databaseUrl);
  if (!target || !isLocalHost(target.host))
    return fail(
      `Refusing to add the stand-in to ${target ? `"${target.host}"` : "a URL that does not parse"}: it is for a throwaway database on this machine.`,
      "Point DATABASE_URL at localhost, 127.0.0.1 or ::1.",
    );

  const client = new Client({ connectionString: databaseUrl, ...pgSsl(databaseUrl) });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await applySupabaseStandIn(client);
  } catch (err) {
    return fail(`Could not apply the stand-in: ${describeError(err).join(" ")}`);
  } finally {
    await client.end().catch(() => undefined);
  }
  log.info(
    `${PREFIX} ✓ ${target.host}:${String(target.port)}/${target.database} has the Supabase roles, auth.users, auth.identities, auth.uid() and auth.role().`,
  );
  return 0;
}
