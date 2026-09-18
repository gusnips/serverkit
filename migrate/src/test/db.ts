/**
 * Throwaway databases for the integration tests: one fresh database per test, dropped after.
 *
 * TEST_DATABASE_URL must point at a Postgres on this machine that the tests may create databases
 * in. Nothing else is accepted, because these tests create roles, drop databases and kill sessions.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import type { Log } from "../runner.ts";
import { describeTarget, isLocalHost } from "../target.ts";

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "TEST_DATABASE_URL is not set. The runner tests need a throwaway local Postgres, e.g. " +
        "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres bun run test",
    );
  const target = describeTarget(url);
  if (!target || !isLocalHost(target.host))
    throw new Error(`TEST_DATABASE_URL must be a database on this machine, not "${url}".`);
  return url;
}

export function urlFor(database: string): string {
  const url = new URL(adminUrl());
  url.pathname = `/${database}`;
  return url.toString();
}

export async function withAdmin<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  url: string;
  name: string;
  query<R extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
  drop(): Promise<void>;
}

export async function freshDatabase(): Promise<TestDatabase> {
  const name = `migrate_test_${Math.random().toString(36).slice(2, 10)}`;
  await withAdmin(async (client) => {
    await client.query(`CREATE DATABASE ${name}`);
    // Tests assert on Postgres's own error text, which a cluster initialised under a non-English
    // locale translates ("coluna … não existe"). Pinned per database rather than per session so
    // the runner's RESET ALL falls back to it instead of clearing it.
    await client.query(`ALTER DATABASE ${name} SET lc_messages = 'C'`);
  });
  const url = urlFor(name);
  return {
    url,
    name,
    async query<R extends object>(sql: string, params: unknown[] = []) {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        return (await client.query<R>(sql, params)).rows;
      } finally {
        await client.end();
      }
    },
    async drop() {
      await withAdmin((client) => client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** A folder of migration files: `{ "001_a.sql": "CREATE TABLE …" }`. */
export async function migrationsDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "migrate-test-"));
  for (const [name, sql] of Object.entries(files)) await writeFile(join(dir, name), sql);
  return dir;
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function captureLog(): Log & { lines: string[]; text(): string } {
  const lines: string[] = [];
  return {
    lines,
    info: (line) => lines.push(line),
    error: (line) => lines.push(line),
    text: () => lines.join("\n"),
  };
}
