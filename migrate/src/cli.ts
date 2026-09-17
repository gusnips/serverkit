import { parseFlags, portFlag, stringFlag, type FlagSpec } from "./args.ts";
import { LOG_PREFIX } from "./lines.ts";
import { runMigrations, type Log, type MigrateOptions } from "./runner.ts";

/** What an adopter's script fixes in code. Flags on the command line add to it. */
export type MigrateConfig = Omit<
  MigrateOptions,
  "dir" | "databaseUrl" | "manual" | "yes" | "status" | "types"
> & {
  dir?: MigrateOptions["dir"];
  /** Defaults to `DATABASE_URL`. */
  databaseUrl?: string;
};

const FLAGS: FlagSpec = {
  manual: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  status: { type: "boolean" },
  types: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  dir: { type: "string" },
  schema: { type: "string" },
  "search-path": { type: "string" },
  "tunnel-port": { type: "string" },
  "types-command": { type: "string" },
};

export const MIGRATE_USAGE = `Apply the .sql migrations in a folder, in order, one transaction per file.

Usage: migrate --dir <folder> [flags]

  --manual              Also apply files marked "-- migrate: manual". Asks first, unless --yes.
  --yes, -y             Skip those questions, and allow a remote database. MIGRATE_CONFIRM=1 does the same.
  --status              Show what a run would apply, and change nothing.
  --types               After a run that applied a file, run the types command.
  --dir <folder>        The folder with the .sql files.
  --schema <name>       The schema for the schema_migrations table. Default: app.
  --search-path <list>  search_path for the connection, e.g. app.
  --tunnel-port <port>  A local port that tunnels to a remote database. Applying there needs --yes.
  --types-command <cmd> The command --types runs, e.g. "bun run db:types".

Reads DATABASE_URL.`;

/**
 * Parse the command line into `runMigrations` and return the exit code.
 *
 * ```ts
 * // apps/api/scripts/run-migrations.ts
 * import { migrateCli } from "@gusnips/migrate";
 *
 * process.exitCode = await migrateCli({ dir: new URL("../migrations", import.meta.url) });
 * ```
 */
export async function migrateCli(
  config: MigrateConfig = {},
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  log?: Log,
): Promise<number> {
  const out = log ?? { info: (line) => console.log(line), error: (line) => console.error(line) };
  const usageError = (message: string) => {
    out.error(`${LOG_PREFIX} ${message}`);
    out.error(MIGRATE_USAGE);
    return 1;
  };

  const { flags, error } = parseFlags(argv, FLAGS);
  if (error) return usageError(error);
  if (flags.help) {
    out.info(MIGRATE_USAGE);
    return 0;
  }

  const tunnelPort = portFlag(flags, "tunnel-port");
  if (typeof tunnelPort === "object") return usageError(tunnelPort.error);
  const dir = stringFlag(flags, "dir") ?? config.dir;
  if (dir === undefined) return usageError("No migrations folder. Pass --dir <folder>.");

  const result = await runMigrations({
    ...config,
    dir,
    databaseUrl: config.databaseUrl ?? env.DATABASE_URL,
    schema: stringFlag(flags, "schema") ?? config.schema,
    searchPath: stringFlag(flags, "search-path") ?? config.searchPath,
    tunnelPort: tunnelPort ?? config.tunnelPort,
    typesCommand: stringFlag(flags, "types-command") ?? config.typesCommand,
    manual: flags.manual === true,
    yes: flags.yes === true || env.MIGRATE_CONFIRM === "1",
    status: flags.status === true,
    types: flags.types === true,
    log,
  });
  return result.exitCode;
}
