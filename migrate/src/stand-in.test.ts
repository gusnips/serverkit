import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { standInCli } from "./stand-in.ts";
import { captureLog, freshDatabase, type TestDatabase } from "./test/db.ts";

let db: TestDatabase;

beforeEach(async () => {
  db = await freshDatabase();
});

afterEach(async () => {
  await db.drop();
});

async function standIn(databaseUrl = db.url, argv: string[] = []) {
  const log = captureLog();
  const code = await standInCli(argv, { DATABASE_URL: databaseUrl }, log);
  return { code, log };
}

describe("supabase-stand-in", () => {
  it("gives a stock Postgres what Supabase migrations reference, and is safe to run twice", async () => {
    expect((await standIn()).code).toBe(0);
    expect((await standIn()).code).toBe(0);

    const roles = await db.query<{ rolname: string; rolbypassrls: boolean }>(
      "SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role') ORDER BY rolname",
    );
    expect(roles).toEqual([
      { rolname: "anon", rolbypassrls: false },
      { rolname: "authenticated", rolbypassrls: false },
      { rolname: "service_role", rolbypassrls: true },
    ]);
    const columns = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'auth' AND table_name = 'users' ORDER BY ordinal_position",
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      "id",
      "email",
      "encrypted_password",
      "is_anonymous",
      "created_at",
      "last_sign_in_at",
    ]);

    // What the migrations on the stack do with it: foreign keys, policies, reads.
    const client = new Client({ connectionString: db.url });
    await client.connect();
    try {
      await client.query(`
        CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users (id));
        ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
        CREATE POLICY own ON public.profiles TO authenticated USING (id = auth.uid() AND auth.role() = 'authenticated');
        GRANT SELECT ON public.profiles TO anon, authenticated, service_role;
        SELECT u.email, u.is_anonymous, i.provider FROM auth.users u JOIN auth.identities i ON i.user_id = u.id;
      `);
      const { rows } = await client.query<{ uid: string | null; role: string | null }>(
        "SELECT auth.uid() AS uid, auth.role() AS role",
      );
      expect(rows[0]).toEqual({ uid: null, role: null });
    } finally {
      await client.end();
    }
  });

  it("adds missing columns to a narrower auth.users an older stand-in made, and replaces nothing", async () => {
    await db.query(`CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY, last_sign_in_at timestamptz);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;`);
    expect((await standIn()).code).toBe(0);
    const email = await db.query("SELECT email, is_anonymous FROM auth.users");
    expect(email).toEqual([]);
    // An existing auth.uid() is left exactly as it was.
    expect(await db.query("SELECT auth.uid()::text AS uid")).toEqual([
      { uid: "00000000-0000-0000-0000-000000000001" },
    ]);
  });

  it("refuses anything that is not on this machine", async () => {
    const { code, log } = await standIn("postgresql://postgres@db.example.com:5432/postgres");
    expect(code).toBe(1);
    expect(log.text()).toContain('Refusing to add the stand-in to "db.example.com"');
  });

  it("refuses an unknown flag", async () => {
    const { code, log } = await standIn(db.url, ["--yes"]);
    expect(code).toBe(1);
    expect(log.lines[0]).toBe('[STAND-IN] Unknown flag "--yes".');
  });
});
