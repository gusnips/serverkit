import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createRedis } from "../redis/index.ts";

/** The suites that need a real Redis skip where `redis-server` is not installed, and say so. */
export const hasRedisServer = spawnSync("redis-server", ["--version"]).status === 0;

/** A throwaway Redis on a free loopback port, with nothing written to disk. */
export async function startRedisServer(): Promise<{ url: string; stop: () => void }> {
  const port = await freePort();
  const server = spawn("redis-server", [
    "--port",
    String(port),
    "--save",
    "",
    "--appendonly",
    "no",
  ]);
  const url = `redis://127.0.0.1:${port}`;
  const probe = createRedis({ url, maxRetriesPerRequest: 1, onError: () => {} });
  for (let i = 0; (await probe.ping().catch(() => "")) !== "PONG" && i < 50; i++)
    await new Promise((r) => setTimeout(r, 50));
  probe.disconnect();
  return { url, stop: () => server.kill() };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}
