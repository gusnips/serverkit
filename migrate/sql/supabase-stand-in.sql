-- The pieces a Supabase database has before its first migration runs, for a stock Postgres in CI.
--
-- Migrations written for Supabase grant to its API roles, reference GoTrue's auth.users, and call
-- auth.uid() and auth.role() in policies. A stock Postgres has none of these, so a replay dies at
-- the first GRANT with `role "service_role" does not exist` before it checks a single table.
--
-- Only what migrations on the stack actually reference is here: nothing for storage, realtime,
-- vault, cron, net or auth.jwt(), because no migration uses them. A migration that starts reading
-- a new column of auth.users should add it here.
--
-- For CI and local replays only. Every statement checks before it creates, and nothing is ever
-- replaced, so running it twice, or over an older stand-in, changes nothing that already exists.

-- The three API roles, as Supabase creates them. service_role bypasses row level security, so a
-- GRANT to it here means what it means in production.
DO $$
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
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;

-- GoTrue's users table, cut down to the columns migrations read, with GoTrue's own types. Columns
-- are added one by one so an older stand-in that created a narrower table gets them too.
CREATE TABLE IF NOT EXISTS auth.users (
    id uuid PRIMARY KEY
);

DO $$
DECLARE
    wanted text[][] := ARRAY[
        ARRAY['email', 'varchar(255)'],
        ARRAY['encrypted_password', 'varchar(255)'],
        ARRAY['is_anonymous', 'boolean NOT NULL DEFAULT false'],
        ARRAY['created_at', 'timestamptz'],
        ARRAY['last_sign_in_at', 'timestamptz']
    ];
    i int;
BEGIN
    FOR i IN 1 .. array_length(wanted, 1) LOOP
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = wanted[i][1]
        ) THEN
            EXECUTE format('ALTER TABLE auth.users ADD COLUMN %I %s', wanted[i][1], wanted[i][2]);
        END IF;
    END LOOP;
END
$$;

CREATE TABLE IF NOT EXISTS auth.identities (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
    provider text NOT NULL
);

-- auth.uid() and auth.role() with Supabase's bodies: the request's JWT claims. Nothing in CI makes
-- a request, so they return null there, but a policy that compiles here compiles in production.
DO $$
BEGIN
    IF to_regprocedure('auth.uid()') IS NULL THEN
        CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
            SELECT coalesce(
                nullif(current_setting('request.jwt.claim.sub', true), ''),
                (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
            )::uuid
        $fn$;
    END IF;
    IF to_regprocedure('auth.role()') IS NULL THEN
        CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $fn$
            SELECT coalesce(
                nullif(current_setting('request.jwt.claim.role', true), ''),
                (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
            )::text
        $fn$;
    END IF;
END
$$;
