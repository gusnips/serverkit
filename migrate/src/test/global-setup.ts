import { withAdmin } from "./db.ts";

/**
 * Roles belong to the whole cluster, not to one database. Test files run in parallel, and two of
 * them creating `service_role` at the same moment can both pass the "does it exist" check and one
 * then fails on the catalog's unique index. Creating them once, up front, turns those checks into
 * what they are in CI: no-ops.
 */
export default async function setup(): Promise<void> {
  await withAdmin((client) =>
    client.query(`DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN NOINHERIT;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
        END IF;
      END $$;`),
  );
}
