import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger/index.ts";
import { bunServerStep, createShutdown, type ShutdownStep } from "./shutdown.ts";

function harness(steps: ShutdownStep[], hardExitMs = 5_000) {
  const lines: string[] = [];
  const exits: number[] = [];
  const logger = {
    info: (message: string, meta?: Record<string, unknown>) =>
      lines.push(`${message} ${JSON.stringify(meta)}`),
    error: (message: string, meta: Record<string, unknown> = {}) =>
      lines.push(
        `${message} ${JSON.stringify("error" in meta ? { ...meta, error: String(meta.error) } : meta)}`,
      ),
  };
  const shutdown = createShutdown(steps, { hardExitMs, logger, exit: (code) => exits.push(code) });
  return { shutdown, lines, exits };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createShutdown", () => {
  it("runs the steps in order, once, and exits 0", async () => {
    const ran: string[] = [];
    const step = (name: string): ShutdownStep => ({ name, run: async () => void ran.push(name) });
    const { shutdown, lines, exits } = harness([step("server"), step("redis"), step("postgres")]);

    const first = shutdown("SIGTERM");
    expect(shutdown("SIGINT")).toBe(first);
    await first;

    expect(ran).toEqual(["server", "redis", "postgres"]);
    expect(exits).toEqual([0]);
    expect(lines[0]).toBe('shutting down {"reason":"SIGTERM"}');
    expect(lines.slice(1, 4)).toEqual([
      'shutdown step {"step":"server"}',
      'shutdown step {"step":"redis"}',
      'shutdown step {"step":"postgres"}',
    ]);
    expect(lines[4]).toMatch(/^shutdown complete \{"exitCode":0,"ms":\d+\}$/);
  });

  it("runs every step after a failed one, and exits 1", async () => {
    const ran: string[] = [];
    const { shutdown, lines, exits } = harness([
      { name: "cron", run: () => Promise.reject(new Error("still ticking")) },
      {
        name: "workers",
        run: () => {
          throw new Error("closed twice");
        },
      },
      { name: "postgres", run: () => void ran.push("postgres") },
    ]);
    await shutdown("SIGTERM");
    expect(ran).toEqual(["postgres"]);
    expect(exits).toEqual([1]);
    expect(lines).toContain('shutdown step failed {"step":"cron","error":"Error: still ticking"}');
    expect(lines).toContain(
      'shutdown step failed {"step":"workers","error":"Error: closed twice"}',
    );
  });

  it("keeps a crash's exit code when the crash lands during a drain a signal started", async () => {
    const { shutdown, exits } = harness([{ name: "server", run: () => settle(20) }]);
    const drain = shutdown("SIGTERM");
    void shutdown("uncaught exception", 1);
    await drain;
    expect(exits).toEqual([1]);
  });

  it("exits 1 once, naming the step that hung, when the backstop fires", async () => {
    const { shutdown, lines, exits } = harness(
      [
        { name: "http server", run: () => undefined },
        { name: "bullmq", run: () => settle(200) },
      ],
      40,
    );
    await shutdown("SIGTERM");
    expect(exits).toEqual([1]);
    expect(lines).toContain('shutdown did not finish in time {"step":"bullmq","hardExitMs":40}');
  });

  it("refuses a backstop that is not a whole number of milliseconds above 0", () => {
    for (const hardExitMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => harness([], hardExitMs)).toThrow("hardExitMs is a whole number");
  });
});

describe("bunServerStep", () => {
  function server(answers: { stop: () => Promise<void> }) {
    const calls: string[] = [];
    return {
      calls,
      stop(force?: boolean) {
        calls.push(force ? "stop(true)" : "stop()");
        return force ? new Promise<void>(() => {}) : answers.stop();
      },
    };
  }

  it("does not force a server that stopped within the grace window", async () => {
    const quiet = server({ stop: () => Promise.resolve() });
    await bunServerStep(quiet, { graceMs: 1_000 }).run();
    expect(quiet.calls).toEqual(["stop()"]);
  });

  it("forces a server a stream holds open, and moves on when the forced stop hangs too", async () => {
    // Bun 1.3.8: neither call settles while an SSE client is attached.
    const streaming = server({ stop: () => new Promise<void>(() => {}) });
    const step = bunServerStep(streaming, { graceMs: 20 });
    expect(step.name).toBe("http server");
    await step.run();
    expect(streaming.calls).toEqual(["stop()", "stop(true)"]);
  });

  it("fails the step when stop() throws", async () => {
    const broken = server({ stop: () => Promise.reject(new Error("not listening")) });
    await expect(bunServerStep(broken, { graceMs: 1_000, name: "api" }).run()).rejects.toThrow(
      "not listening",
    );
  });
});

// The handlers act on the real process, so each case runs in a child and is sent real signals.
const SHUTDOWN = fileURLToPath(new URL("./shutdown.ts", import.meta.url));
const FIXTURE = join(mkdtempSync(join(tmpdir(), "serverkit-shutdown-")), "process.mjs");
writeFileSync(
  FIXTURE,
  `import { createShutdown, installProcessHandlers } from ${JSON.stringify(SHUTDOWN)};
const mode = process.argv[2];
const log = (message, meta = {}) =>
  console.log(JSON.stringify({ message, ...meta, error: meta.error && String(meta.error) }));
const logger = { info: log, error: log };
const server = setInterval(() => {}, 1_000);
const steps = [{ name: "server", run: () => clearInterval(server) }];
// Holds no handle, so an unref'd backstop would let the process exit 0 here.
if (mode === "hang") steps.push({ name: "stuck", run: () => new Promise(() => {}) });
if (mode === "slow") steps.push({ name: "slow", run: () => new Promise((r) => setTimeout(r, 2_000)) });
const shutdown = createShutdown(steps, { hardExitMs: mode === "hang" ? 300 : 5_000, logger });
installProcessHandlers(shutdown, { logger, rejections: mode === "reject-exit" ? "exit" : "survive" });
if (mode === "throw") setTimeout(() => { throw new Error("boom"); }, 10);
if (mode.startsWith("reject")) Promise.reject(new Error("nope"));
setTimeout(() => log("ready"), 50);
`,
);

interface Run {
  code: number | null;
  messages: string[];
  lines: Record<string, unknown>[];
}

function run(runtime: string, mode: string, signals: NodeJS.Signals[] = []): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [FIXTURE, mode], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes('"message":"ready"') && signals.length > 0) {
        for (const signal of signals.splice(0)) child.kill(signal);
      }
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const lines = out
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      resolve({ code, lines, messages: lines.map((line) => String(line.message)) });
    });
  });
}

describe.each([
  ["node", process.execPath],
  ["bun", "bun"],
])("installProcessHandlers, on %s", (_name, runtime) => {
  it("drains on SIGTERM and exits 0", async () => {
    const { code, messages, lines } = await run(runtime, "clean", ["SIGTERM"]);
    expect(code).toBe(0);
    expect(lines[1]).toEqual({ message: "shutting down", reason: "SIGTERM" });
    expect(messages.slice(2)).toEqual(["shutdown step", "shutdown complete"]);
  });

  it("exits 1, naming the step, when a step hangs holding nothing", async () => {
    const { code, lines } = await run(runtime, "hang", ["SIGINT"]);
    expect(code).toBe(1);
    expect(lines.at(-1)).toEqual({
      message: "shutdown did not finish in time",
      step: "stuck",
      hardExitMs: 300,
    });
  });

  it("exits 1 at once on a second signal", async () => {
    const { code, messages } = await run(runtime, "slow", ["SIGTERM", "SIGINT"]);
    expect(code).toBe(1);
    expect(messages.at(-1)).toBe("second stop signal, exiting without waiting for the drain");
    expect(messages).not.toContain("shutdown complete");
  });

  it("logs an uncaught exception, drains, and exits 1", async () => {
    const { code, lines } = await run(runtime, "throw");
    expect(code).toBe(1);
    expect(lines[0]).toEqual({ message: "uncaught exception", error: "Error: boom" });
    expect(lines.at(-1)).toMatchObject({ message: "shutdown complete", exitCode: 1 });
  });

  it("logs a rejection and keeps serving when told to survive", async () => {
    const { code, messages } = await run(runtime, "reject-survive", ["SIGTERM"]);
    expect(code).toBe(0);
    expect(messages.slice(0, 2)).toEqual(["unhandled rejection", "ready"]);
  });

  it("logs a rejection, drains, and exits 1 when told to exit", async () => {
    const { code, lines } = await run(runtime, "reject-exit");
    expect(code).toBe(1);
    expect(lines[0]).toEqual({ message: "unhandled rejection", error: "Error: nope" });
    expect(lines.at(-1)).toMatchObject({ message: "shutdown complete", exitCode: 1 });
  });
});

// The README's snippet. It lives here and not in readme.test.ts, whose program is the Worker's.
describe("README — stopping for a deploy", () => {
  it("stops taking work, closes Redis, then Postgres, and exits 0", async () => {
    const closed: string[] = [];
    const server = { stop: async () => void closed.push("server") };
    const redis = { quit: async () => void closed.push("redis") };
    const pool = { end: async () => void closed.push("postgres") };
    const exits: number[] = [];
    const shutdown = createShutdown(
      [
        bunServerStep(server, { graceMs: 5_000 }),
        { name: "redis", run: () => redis.quit() },
        { name: "postgres", run: () => pool.end() },
      ],
      {
        hardExitMs: 25_000,
        logger: createLogger({ level: "silent" }),
        exit: (code) => exits.push(code),
      },
    );
    await shutdown("SIGTERM");
    expect(closed).toEqual(["server", "redis", "postgres"]);
    expect(exits).toEqual([0]);
  });
});
