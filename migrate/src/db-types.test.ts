import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbTypesCli } from "./db-types-cli.ts";
import { generateTypes } from "./db-types.ts";
import {
  captureLog,
  freshDatabase,
  migrationsDir,
  removeDir,
  type TestDatabase,
} from "./test/db.ts";

let db: TestDatabase;
let out: string;

beforeAll(async () => {
  db = await freshDatabase();
  out = await migrationsDir({});
  await db.query(`
    CREATE SCHEMA app;
    CREATE TYPE app.plan AS ENUM ('free', 'pro', 'team');
    CREATE TABLE app.accounts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      plan app.plan NOT NULL DEFAULT 'free',
      tags text[] NOT NULL,
      balance money,
      "display name" text
    );
    CREATE TABLE app.orders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      account_id bigint NOT NULL REFERENCES app.accounts (id),
      total numeric NOT NULL,
      meta jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(meta ->> 'note', ''))) STORED,
      shape point
    );
    CREATE VIEW app.order_totals AS SELECT account_id, sum(total) AS total FROM app.orders GROUP BY account_id;
    CREATE TABLE public.elsewhere (x int);
  `);
});

afterAll(async () => {
  await db.drop();
  await removeDir(out);
});

describe("generateTypes, supabase shape", () => {
  it("emits Row, Insert, Update and Relationships per table", async () => {
    const { text, tables, views, enums, unmapped } = await generateTypes({ databaseUrl: db.url });
    expect({ tables, views, enums, unmapped }).toEqual({
      tables: 2,
      views: 1,
      enums: 1,
      unmapped: [],
    });
    expect(text).toContain(
      [
        "            orders: {",
        "                Row: {",
        "                    id: string;",
        "                    account_id: number;",
        "                    total: number;",
        "                    meta: Json | null;",
        "                    created_at: string;",
        "                    search: string | null;",
        "                    shape: string | null;",
        "                };",
        "                Insert: {",
        "                    id?: string;",
        "                    account_id: number;",
        "                    total: number;",
        "                    meta?: Json | null;",
        "                    created_at?: string;",
        "                    search?: string | null;",
        "                    shape?: string | null;",
        "                };",
      ].join("\n"),
    );
    expect(text).toContain(
      '{ foreignKeyName: "orders_account_id_fkey"; columns: ["account_id"]; isOneToOne: false; referencedRelation: "accounts"; referencedColumns: ["id"]; }',
    );
  });

  it("resolves enum columns, arrays, quoted names and money", async () => {
    const { text } = await generateTypes({ databaseUrl: db.url });
    expect(text).toContain('                    plan: Database["app"]["Enums"]["plan"];');
    expect(text).toContain("                    tags: string[];");
    expect(text).toContain('                    "display name": string | null;');
    // money's text form is `$1.00`, which is not a JSON number.
    expect(text).toContain("                    balance: string | null;");
    expect(text).toContain('            plan: "free" | "pro" | "team";');
  });

  it("emits views as Row-only read models, and helpers named after the schema", async () => {
    const { text } = await generateTypes({ databaseUrl: db.url });
    expect(text).toContain(
      "        Views: {\n            order_totals: {\n                Row: {\n                    account_id: number | null;\n                    total: number | null;\n                };\n                Relationships: [];\n            };\n        };",
    );
    expect(text).toContain('type AppSchema = Database["app"];');
    expect(text).toContain(
      'export type Enums<T extends keyof AppSchema["Enums"]> = AppSchema["Enums"][T];',
    );
    expect(text).not.toContain("elsewhere");
  });

  it("writes the same bytes twice, with no timestamp", async () => {
    const first = await generateTypes({ databaseUrl: db.url });
    const second = await generateTypes({ databaseUrl: db.url });
    expect(second.text).toBe(first.text);
    expect(first.text.split("\n").slice(0, 5)).toEqual([
      "// ---------------------------------------------------------------------------",
      "// AUTO-GENERATED — DO NOT EDIT BY HAND.",
      "// Regenerate after a schema change with db-types from @gusnips/migrate.",
      "// Source: live Postgres `app` schema, shape `supabase`.",
      "// ---------------------------------------------------------------------------",
    ]);
  });

  it("says never for empty sections", async () => {
    const { text } = await generateTypes({ databaseUrl: db.url, schema: "public" });
    expect(text).toContain("        Views: {\n            [_ in never]: never;\n        };");
    expect(text).toContain("        Enums: {\n            [_ in never]: never;\n        };");
    expect(text).toContain('type PublicSchema = Database["public"];');
  });
});

describe("generateTypes, rows shape", () => {
  it("emits only Row shapes, with TableName and Tables", async () => {
    const { text } = await generateTypes({ databaseUrl: db.url, shape: "rows" });
    expect(text).not.toContain("Insert");
    expect(text).not.toContain("Relationships");
    expect(text).not.toContain("Functions");
    expect(text).toContain(
      "            accounts: {\n                Row: {\n                    id: number;",
    );
    expect(text).toContain('export type TableName = keyof AppSchema["Tables"];');
    expect(text).toContain(
      'export type Tables<T extends TableName> = AppSchema["Tables"][T]["Row"];',
    );
    expect(text).toContain('            plan: "free" | "pro" | "team";');
  });
});

describe("db-types CLI", () => {
  const cli = async (argv: string[]) => {
    const log = captureLog();
    const code = await dbTypesCli(argv, { DATABASE_URL: db.url }, log);
    return { code, log };
  };

  it("writes the file, then --check passes until the schema moves", async () => {
    const file = join(out, "nested", "database.types.ts");
    expect((await cli(["--out", file])).code).toBe(0);
    expect(await readFile(file, "utf8")).toContain("export type Database");

    const clean = await cli(["--out", file, "--check"]);
    expect(clean.code).toBe(0);
    expect(clean.log.text()).toContain("is up to date");

    await writeFile(
      file,
      (await readFile(file, "utf8")).replace("total: number;", "total: string;"),
    );
    const drifted = await cli(["--out", file, "--check"]);
    expect(drifted.code).toBe(1);
    expect(drifted.log.text()).toMatch(/is out of date: line \d+ is "\s+total: string;" on disk/);
  });

  it("checks after --format, because the committed file is the formatted one", async () => {
    const file = join(out, "formatted.types.ts");
    // A stand-in formatter: two-space indent instead of four.
    const format = `sed 's/    /  /g'`;
    expect((await cli(["--out", file, "--format", format])).code).toBe(0);
    expect(await readFile(file, "utf8")).toContain("\n  app: {\n");
    expect((await cli(["--out", file, "--format", format, "--check"])).code).toBe(0);
    expect((await cli(["--out", file, "--check"])).code).toBe(1);
  });

  it("fails when the format command fails, and says so", async () => {
    const run = await cli(["--out", join(out, "x.ts"), "--format", "echo broken >&2; exit 2"]);
    expect(run.code).toBe(1);
    expect(run.log.text()).toContain("The format command exited with 2");
    expect(run.log.text()).toContain("broken");
  });

  it("reports a missing file under --check", async () => {
    const run = await cli(["--out", join(out, "missing.ts"), "--check"]);
    expect(run.code).toBe(1);
    expect(run.log.text()).toContain("missing.ts does not exist.");
  });

  it("refuses unknown flags and bad values", async () => {
    expect((await cli(["--out", "x.ts", "--status"])).log.lines[0]).toBe(
      '[DB-TYPES] Unknown flag "--status".',
    );
    expect((await cli(["--out", "x.ts", "--shape", "prisma"])).log.lines[0]).toBe(
      '[DB-TYPES] --shape must be supabase or rows, but got "prisma".',
    );
    expect((await cli([])).log.lines[0]).toBe("[DB-TYPES] No output file. Pass --out <file>.");
  });

  it("warns when the schema has no tables", async () => {
    const run = await cli(["--out", join(out, "empty.ts"), "--schema", "nothing_here"]);
    expect(run.code).toBe(0);
    expect(run.log.text()).toContain("has no tables this role can see");
  });
});

describe("foreign keys into another schema", () => {
  let other: TestDatabase;

  beforeAll(async () => {
    other = await freshDatabase();
    await other.query(`
      CREATE SCHEMA auth;
      CREATE TABLE auth.users (id uuid PRIMARY KEY);
      CREATE SCHEMA app;
      CREATE TABLE app.users (id uuid PRIMARY KEY REFERENCES auth.users (id));
      CREATE TABLE app.notes (id int PRIMARY KEY, author uuid REFERENCES app.users (id));
    `);
  });

  afterAll(async () => {
    await other.drop();
  });

  it("are left out, so auth.users never reads as app.users", async () => {
    // The `Database` type describes one schema, so a relationship can only name a relation in it.
    // Emitted with its bare name, `REFERENCES auth.users` became a self-relationship of app.users,
    // and `from("users").select("*, users(*)")` typechecked against a join PostgREST refuses.
    const { text } = await generateTypes({ databaseUrl: other.url });
    expect(text).not.toContain("users_id_fkey");
    expect(text).toContain(
      '{ foreignKeyName: "notes_author_fkey"; columns: ["author"]; isOneToOne: false; referencedRelation: "users"; referencedColumns: ["id"]; }',
    );
  });
});
