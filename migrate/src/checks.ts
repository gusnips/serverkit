import type { Client } from "pg";
import { LOG_PREFIX } from "./lines.ts";
import type { Log } from "./runner.ts";

/**
 * An `inspect` hook for Supabase: warn about tables in `schema` that `service_role` cannot read.
 *
 * ```ts
 * migrateCli({ dir, inspect: unreadableTablesCheck("public") });
 * ```
 *
 * A policy filters rows; a GRANT is what gives access at all. A migration that creates a table and
 * its policies but no grant works wherever the creating role's default privileges cover the API
 * roles, and fails everywhere else with `permission denied for table <x>`, often months later.
 * One staging database carried 25 such tables because its `pg_default_acl` was empty while every
 * table belonged to `supabase_admin`. It warns and never fails the run: it reports the state of
 * the database, not a fault in the migration.
 */
export function unreadableTablesCheck(
  schema = "public",
): (client: Client, log: Log) => Promise<void> {
  return async (client, log) => {
    const { rows } = await client.query<{ tablename: string; tableowner: string }>(
      `SELECT t.tablename, t.tableowner
         FROM pg_tables t
        WHERE t.schemaname = $1
          AND NOT EXISTS (
            SELECT 1 FROM information_schema.role_table_grants g
             WHERE g.table_schema = $1 AND g.table_name = t.tablename
               AND g.grantee = 'service_role' AND g.privilege_type = 'SELECT'
          )
        ORDER BY t.tablename`,
      [schema],
    );
    if (rows.length === 0) return;

    const shown = rows.slice(0, 10).map((row) => row.tablename);
    const rest = rows.length - shown.length;
    const owner = rows[0]?.tableowner ?? "the creating role";
    log.error(
      `${LOG_PREFIX} ⚠ ${String(rows.length)} table(s) in "${schema}" that service_role cannot read: ` +
        `${shown.join(", ")}${rest > 0 ? `, and ${String(rest)} more` : ""}.`,
    );
    log.error(
      `${LOG_PREFIX}   Every read of them fails with "permission denied for table", whatever their ` +
        `policies say. To fix it on this database:`,
    );
    log.error(
      `${LOG_PREFIX}     GRANT ALL ON ALL TABLES IN SCHEMA ${schema} TO anon, authenticated, service_role;`,
    );
    log.error(
      `${LOG_PREFIX}     ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated, service_role;`,
    );
  };
}
