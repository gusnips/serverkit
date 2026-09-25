/**
 * Stopping a process for a deploy: stop taking work, let the work in flight finish, close what it
 * used, and exit with a code that says whether all of that worked.
 *
 * What the thirteen hand-written drains in the fleet taught:
 * - **The order is the list.** Two backends closed the database pool while the server was still
 *   serving, so every request the drain existed for failed on "Cannot use a pool after calling
 *   end". A call site can swap two statements by accident; it cannot reorder a list it passes in.
 * - **A failed step does not stop the rest, and it decides the exit code.** A cron that will not
 *   stop is no reason to leave the pool open. One worker always exited 0, so its process manager
 *   read a failed drain as a clean one.
 * - **The backstop is armed before the first step, and it keeps the process alive.** Every copy
 *   `unref`'d its timer. When a step hangs holding no socket, that lets the process exit 0 in the
 *   middle of the drain, with nothing logged (measured on Node 22, Bun 1.3.8 and Bun 1.4.2). The
 *   sequence always ends in `exit`, so a live timer keeps nothing alive for longer.
 * - **One drain per process.** Ten APIs ran the whole sequence again on a second signal, and
 *   pg-pool's `end()` rejects when it is called a second time.
 */
import type { Logger } from "../logger/index.ts";

export interface ShutdownStep {
  /** Logged as the step starts, so a deploy that stops moving says where it stopped. */
  name: string;
  run: () => unknown;
}

export interface ShutdownOptions {
  /**
   * The most the whole sequence may take before the process exits 1 anyway. It must sit under the
   * process manager's kill timeout, or the manager's SIGKILL lands first and the log never says
   * which step hung. And in a worker it must cover the longest job it lets finish.
   */
  hardExitMs: number;
  logger: Pick<Logger, "info" | "error">;
  /** For a test. Defaults to `process.exit`. */
  exit?: (code: number) => void;
}

/** Starts the drain, or returns the one already running. The first code other than 0 is kept. */
export type Shutdown = (reason: string, exitCode?: number) => Promise<void>;

/**
 * Runs `steps` in order, once, then exits:
 *
 *     let shutdown: Shutdown = createShutdown([], { hardExitMs: 25_000, logger });
 *     installProcessHandlers((reason, code) => shutdown(reason, code), { logger, rejections: "survive" });
 *     // …boot: the env, the pool, Redis, the server…
 *     shutdown = createShutdown(
 *       [
 *         bunServerStep(server, { graceMs: 5_000 }),
 *         { name: "redis", run: () => redis.quit() },
 *         { name: "postgres", run: () => pool.end() },
 *       ],
 *       { hardExitMs: 25_000, logger },
 *     );
 */
export function createShutdown(steps: readonly ShutdownStep[], options: ShutdownOptions): Shutdown {
  const { hardExitMs, logger, exit = (code: number) => process.exit(code) } = options;
  if (!(Number.isInteger(hardExitMs) && hardExitMs > 0))
    throw new TypeError(`hardExitMs is a whole number of milliseconds above 0, not ${hardExitMs}`);

  let code = 0;
  let exited = false;
  let draining: Promise<void> | undefined;
  const leave = (exitCode: number) => {
    if (exited) return;
    exited = true;
    exit(exitCode);
  };

  async function drain(reason: string): Promise<void> {
    const started = Date.now();
    let current = "";
    logger.info("shutting down", { reason });
    const backstop = setTimeout(() => {
      logger.error("shutdown did not finish in time", { step: current, hardExitMs });
      leave(1);
    }, hardExitMs);

    for (const step of steps) {
      current = step.name;
      logger.info("shutdown step", { step: step.name });
      try {
        await step.run();
      } catch (error) {
        if (code === 0) code = 1;
        logger.error("shutdown step failed", { step: step.name, error });
      }
    }

    clearTimeout(backstop);
    logger.info("shutdown complete", { exitCode: code, ms: Date.now() - started });
    leave(code);
  }

  return (reason, exitCode = 0) => {
    if (code === 0) code = exitCode;
    draining ??= drain(reason);
    return draining;
  };
}

/**
 * The step that stops a `Bun.serve` server. It stops taking connections at once, gives the
 * requests in flight `graceMs` to finish, then closes whatever is still open.
 *
 * Bun's `stop()` resolves only when every connection has closed, and an SSE stream never closes on
 * its own: an API with one stream open waited out its whole backstop, and never closed Redis or
 * Postgres. Bun 1.3.8's `stop(true)` leaves a streaming connection open too (measured: still
 * connected 20 seconds later, where Bun 1.4.2 closes it at once). So the forced stop gets the same
 * window, the steps after it run either way, and what is left closes with the process. A `stop()`
 * that rejects still gets the forced stop, then fails the step with its own error: the drain it
 * replaced force-closed either way, and a rejection says nothing about what is still connected.
 */
export function bunServerStep(
  server: { stop(closeActiveConnections?: boolean): unknown },
  options: { graceMs: number; name?: string },
): ShutdownStep {
  const { graceMs, name = "http server" } = options;
  return {
    name,
    async run() {
      let failed = false;
      let failure: unknown;
      const stopped = await settlesWithin(graceMs, server.stop()).catch((error: unknown) => {
        failed = true;
        failure = error;
        return false;
      });
      if (!stopped) await settlesWithin(graceMs, server.stop(true));
      if (failed) throw failure;
    },
  };
}

async function settlesWithin(ms: number, work: unknown): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([Promise.resolve(work).then(() => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** How close a second stop signal may follow the first and still be the same stop. */
const SAME_STOP_MS = 1_000;

export interface ProcessHandlerOptions {
  logger: Pick<Logger, "error">;
  /**
   * What a rejected promise nobody handled does. `"survive"` logs it, for an API whose requests
   * share no state. `"exit"` logs it and drains, for a worker where a half-run job may have left
   * state wrong. Required, because the fleet uses both on purpose.
   */
  rejections: "survive" | "exit";
  /** SIGTERM and SIGINT unless you say otherwise: pm2 stops a process with SIGINT by default. */
  signals?: readonly NodeJS.Signals[];
}

/**
 * Drains on a stop signal and on an uncaught exception, and logs every crash through `logger`.
 * Without these, a crash reaches only stderr, and the structured log shows nothing.
 *
 * An uncaught exception drains, then exits 1. Sixteen processes in the fleet exited at once, which
 * cut every healthy request in flight for one bug; the backstop bounds a drain the bug has broken.
 *
 * A second stop signal exits 1 at once, so a person pressing Ctrl+C twice does not wait out a
 * worker's ten-minute budget. One that arrives within a second of the first is the same stop,
 * delivered twice, and is ignored: pm2 signals every process in the tree, and a wrapper such as
 * `bun run` forwards SIGINT and SIGTERM to its child too, so under `bun run start` the app got the
 * stop twice in the same millisecond (measured on Bun 1.4.2, Linux). Read as a person, that skipped
 * the drain. The two often merge first, since signals do not queue, which is what hid it.
 */
export function installProcessHandlers(shutdown: Shutdown, options: ProcessHandlerOptions): void {
  const { logger, rejections, signals = ["SIGTERM", "SIGINT"] } = options;
  process.on("uncaughtException", (error) => {
    logger.error("uncaught exception", { error });
    void shutdown("uncaught exception", 1);
  });
  // Needed for "exit" too. On Bun, a rejection with no listener of its own exits 1 at once, past
  // the `uncaughtException` listener and the drain (measured on 1.3.8 and 1.4.2); Node hands it to
  // that listener instead.
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { error: reason });
    if (rejections === "exit") void shutdown("unhandled rejection", 1);
  });
  let firstAt: number | undefined;
  for (const signal of signals)
    process.on(signal, () => {
      if (firstAt !== undefined) {
        if (Date.now() - firstAt < SAME_STOP_MS) return;
        logger.error("second stop signal, exiting without waiting for the drain", { signal });
        process.exit(1);
      }
      firstAt = Date.now();
      void shutdown(signal);
    });
}
