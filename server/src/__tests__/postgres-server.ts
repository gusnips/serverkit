import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { freePort } from "./redis-server.ts";

/** The suites that need a real Postgres skip where `initdb` is not installed, and say so. */
export const hasPostgres = spawnSync("initdb", ["--version"]).status === 0;

/**
 * A throwaway Postgres cluster in a temp dir, on a free loopback port. Its own cluster rather than
 * a URL to an existing one, so no test here can ever reach a database somebody cares about.
 */
export async function startPostgres(): Promise<{ url: string; stop: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "serverkit-pg-"));
  const data = join(dir, "data");
  const init = spawnSync("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "--no-locale"]);
  if (init.status !== 0) throw new Error(`initdb failed: ${String(init.stderr)}`);
  const port = await freePort();
  // No socket file: the temp dir's path can be longer than a Unix socket path may be.
  const server = spawn("postgres", [
    "-D",
    data,
    "-p",
    String(port),
    "-c",
    "listen_addresses=127.0.0.1",
    "-c",
    "unix_socket_directories=",
    "-c",
    "fsync=off",
  ]);
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres`;
  for (let i = 0; !(await canConnect(url)); i++) {
    if (i === 100) throw new Error(`postgres did not start on port ${port}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return {
    url,
    stop: async () => {
      const exited = new Promise((resolve) => server.once("exit", resolve));
      server.kill();
      await exited;
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function canConnect(url: string): Promise<boolean> {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}
