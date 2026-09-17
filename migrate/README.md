# @gusnips/migrate

Apply the `.sql` files in a folder to Postgres, in order, one transaction per file. It also writes
TypeScript types from the database, and gives a stock Postgres in CI the roles and `auth` tables a
Supabase database starts with.

```bash
bun add @gusnips/migrate pg
```

```bash
DATABASE_URL=postgresql://postgres@localhost:5432/app bunx gusnips-migrate --dir migrations
```

```
[MIGRATIONS] Connected to localhost:5432/app.
[MIGRATIONS] Applying 001_users.sql (1 of 2)...
[MIGRATIONS] ✓ Applied 001_users.sql.
[MIGRATIONS] Applying 002_orders.sql (2 of 2)...
[MIGRATIONS] ✓ Applied 002_orders.sql.
[MIGRATIONS] Done. Applied 2 migration(s); 0 were already applied.
```

Run it again and it says `All migrations already applied. Nothing to do.`

## How it works

- Files run in name order, and numbers sort as numbers: `2_x.sql` before `10_x.sql`.
- Each file runs in its own transaction. If it fails, none of it stays, and no later file runs.
- A file's name without `.sql` is its version. Applied versions go in
  `app.schema_migrations (version text primary key, applied_at timestamptz)`.
- Before each file, the session goes back to its starting settings (`RESET ALL`). A settings change
  in one file, like the `search_path` a `pg_dump` baseline empties, cannot break the next.
- Two runs at once cannot both apply the same file: each takes a lock first, and the second waits
  up to two minutes, then stops and names the session that holds it.

There are no down migrations and no checksums. To undo something, write a new file.

## Directives

Put these in the comment block at the top of a file. Anywhere else, they are an error.

```sql
-- migrate: manual drops three columns with customer data
ALTER TABLE app.products DROP COLUMN trade_in_value;
```

`-- migrate: manual` holds the file back until a run passes `--manual`. Use it for a change a person
should watch: a long lock, a rewrite of a big table, a drop of data. It still runs in a transaction.
Later files still apply; the held file is reported on its own line (see [Deploys](#deploys)).

```sql
-- migrate: no-transaction
CREATE INDEX CONCURRENTLY orders_account_idx ON app.orders (account_id);
CREATE INDEX CONCURRENTLY orders_created_idx ON app.orders (created_at);
```

`-- migrate: no-transaction` runs the statements one at a time, outside a transaction. Postgres
needs this for `CREATE INDEX CONCURRENTLY`, `VACUUM` and a few others. If one statement fails, the
ones before it stay applied.

The old `-- @manual` marker is an error on any line of a file. Write one or both directives, at the
top, instead.

## Flags

| Flag                    | What it does                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| `--dir <folder>`        | The folder with the `.sql` files.                                                              |
| `--manual`              | Also apply held files. It asks about each one first.                                           |
| `--yes`, `-y`           | Answer yes to those questions, and allow a remote database. `MIGRATE_CONFIRM=1` does the same. |
| `--status`              | Show what a run would apply. Changes nothing and takes no lock.                                |
| `--types`               | After a run that applied a file, run the types command.                                        |
| `--schema <name>`       | Where `schema_migrations` lives. Default `app`.                                                |
| `--search-path <list>`  | `search_path` for the connection, for files that use unqualified names.                        |
| `--tunnel-port <port>`  | A local port that tunnels to a remote database. Applying there needs `--yes`.                  |
| `--types-command <cmd>` | The command `--types` runs.                                                                    |

Any other flag is an error, and nothing runs. `--manual` without a terminal to ask on, and without
`--yes`, is an error too.

It reads `DATABASE_URL` and nothing else: no `.env` file. Pass one with `bun --env-file=.env`.

## In a script

Most apps keep a small script, so the folder and settings live in code:

```ts
// apps/api/scripts/run-migrations.ts
import { migrateCli } from "@gusnips/migrate";

process.exitCode = await migrateCli({
  dir: new URL("../migrations", import.meta.url),
  tunnelPort: 5434,
  typesCommand: "bun run db:types",
});
```

Flags on the command line still work: `bun apps/api/scripts/run-migrations.ts --status`.

Other settings: `searchPath`, `rlsOnTrackingTable` (turns on row level security for the tracking
table), `lockKey`, `lockWaitSeconds`, and `inspect`, a read-only check that runs after `--status`
and after a run that applied something. `unreadableTablesCheck("public")` is one: it warns about
Supabase tables that `service_role` has no grant to read.

To use the runner without the command line, call `runMigrations(options)`. It never exits the
process; it returns `{ exitCode, applied, held, pending, appliedWithoutFile }`.

## Deploys

Exit code 0 means the run did what it was asked, including holding a file. Exit code 1 means a file
failed, the run refused, or the input was wrong.

A held file prints one line, for a workflow to turn into a warning:

```
[MIGRATIONS] MANUAL_PENDING 013_drop_trade_in.sql — drops three columns with customer data
```

```bash
grep -F '[MIGRATIONS] MANUAL_PENDING' migrate.log | while read -r LINE; do
  echo "::warning title=Held migration::${LINE#*MANUAL_PENDING }"
done
```

`--status` prints `[MIGRATIONS] Status: PENDING 2: 041_a.sql, 042_b.sql` when a run would apply
something, and `[MIGRATIONS] Status: up to date (40 applied).` when not. It also lists versions that
are recorded as applied but have no file. If it cannot reach the database, it exits 1 and prints no
`Status:` line, so a dead check never reads as "up to date".

The exact strings are exported (`MANUAL_PENDING`, `STATUS_PENDING`, `STATUS_UP_TO_DATE`) and pinned
by a test.

### The remote-database guard

A laptop's `.env` often reaches production, sometimes through an SSH tunnel on a local port. So a
run that would apply something refuses without `--yes` when the host is not this machine, or when
the port is `tunnelPort`. A run with nothing to apply never asks.

Seed and smoke scripts can use the same rule:

```ts
import { requireLocalDatabase } from "@gusnips/migrate";

requireLocalDatabase("SEED", process.env.DATABASE_URL, { tunnelPort: 5434 });
```

`describeTarget(url)` and `confirmationReason(target, { tunnelPort })` are exported too.

## Types

```bash
bunx gusnips-migrate db-types --out src/database.types.ts
```

It reads the `app` schema and writes a `Database` type for supabase-js: `Row`, `Insert`, `Update`
and `Relationships` per table, views, enums, and `Tables<"orders">`, `TablesInsert`, `TablesUpdate`
and `Enums` helpers.

| Flag                 | What it does                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| `--out <file>`       | Where the types go.                                                                |
| `--schema <name>`    | The schema to read. Default `app`.                                                 |
| `--shape rows`       | Only `Row` types, with `Tables` and `TableName`, for code that uses `pg` directly. |
| `--format <command>` | A command that reads the file on stdin and prints it formatted.                    |
| `--check`            | Write nothing. Exit 1 if the file on disk differs from what it would write.        |

The output has no timestamp, so the same schema always gives the same bytes. It is written with
4-space indents and double quotes; pass your own formatter to match your repo:

```bash
bunx gusnips-migrate db-types --out src/database.types.ts \
  --format "bunx prettier --stdin-filepath src/database.types.ts"
```

`--check` compares after `--format`, because the file you commit is the formatted one.

Generated columns and `GENERATED ALWAYS` identity columns are `?: never` in `Insert` and `Update`,
because Postgres refuses a value for them. Foreign keys into another schema, like
`REFERENCES auth.users`, are left out of `Relationships`.

## CI

A Supabase project already has the `anon`, `authenticated` and `service_role` roles, `auth.users`,
`auth.identities`, `auth.uid()` and `auth.role()`. A stock Postgres does not, so migrations written
for Supabase fail at their first `GRANT`. `gusnips-migrate supabase-stand-in` creates them:

```yaml
- run: bun install --frozen-lockfile
- run: bunx gusnips-migrate supabase-stand-in
- run: bunx gusnips-migrate --dir apps/api/migrations --manual --yes
- run: bunx gusnips-migrate db-types --out src/database.types.ts --format "bunx prettier --stdin-filepath src/database.types.ts" --check
```

`bunx gusnips-migrate` runs the copy the install put in `node_modules`. Where the package is not
installed, write `bunx -p @gusnips/migrate gusnips-migrate`. Without `-p`, bunx looks for a package
named after the command, and whoever owns that name on npm gets to run with your `DATABASE_URL`.

It refuses any database that is not on this machine, and running it twice changes nothing. The SQL
is also at `@gusnips/migrate/supabase-stand-in.sql` for `psql -f`.

Replays run with `--manual --yes`, so every file applies in order, held ones included.

## SSL

```ts
import { pgSsl } from "@gusnips/migrate";

new Pool({ connectionString: url, ...pgSsl(url) });
```

An `sslmode` in the URL wins. Supabase cloud hosts (`*.supabase.co`, `*.pooler.supabase.com`) get TLS
without a certificate check. Every other host gets `ssl: false`. To check certificates, put
`sslmode=verify-full` in the URL.

## Requirements

Node 22 or Bun, and `pg` 8.21 or newer.

MIT
