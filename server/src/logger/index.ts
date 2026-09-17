/**
 * One JSON line per event, on stdout, and nothing else.
 *
 * Twelve backends were read for this and none of them installs a logging library. The measured
 * gap between 60 lines of `console.log(JSON.stringify(...))` and a real one is not levels,
 * transports or child loggers — it is the error serializer, and the standard one ships the same
 * copy-loop this package exists to remove. So the package ships no logging library, no transports,
 * no file rotation and no extra levels. Every backend here runs under a process manager or a
 * container that already owns stdout; nothing in twelve repos writes a log file.
 */
import { errorReplacer } from "./serialize.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

/** A threshold, which is a level or "silent". "silent" is not a level: nothing logs AT it. */
export type LogThreshold = LogLevel | "silent";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  /**
   * The lowest level that gets written. Defaults to "info".
   *
   * It is an argument rather than a `process.env.LOG_LEVEL` read, and that is the boundary this
   * package is built on: a Cloudflare Worker has no `process` at all, so a module-scope read makes
   * the package Node-only by accident. The adopter writes the read:
   *
   *     export const logger = createLogger({ level: process.env.LOG_LEVEL });
   *
   * and a Worker writes `createLogger({ level: env.LOG_LEVEL })` from its handler argument.
   *
   * Typed `string` on purpose, so passing `process.env.LOG_LEVEL` needs no cast. An unrecognized
   * value throws — see `resolveThreshold`.
   */
  level?: string | undefined;
  /**
   * Where a finished line goes. Defaults to the console, `error`/`warn` to stderr.
   *
   * This is a seam, not a transport — the package ships none. It exists because one backend in
   * the fleet needs the line twice (stdout and a batched exporter it flushes on SIGTERM), and
   * because without it every test of anything that logs has to monkey-patch a global.
   */
  write?: (line: string, level: LogLevel) => void;
}

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SILENT = Number.POSITIVE_INFINITY;

function resolveThreshold(level: string | undefined): number {
  if (level === undefined || level === "") return LEVELS.info;
  if (level === "silent") return SILENT;
  const known = LEVELS[level as LogLevel];
  if (known !== undefined) return known;
  // Loud, at construction, rather than silently falling back to "info": a box running at the
  // wrong level is discovered during the incident it was meant to explain. This is called once
  // at boot, so a typo fails the deploy instead of the 3am read.
  throw new Error(
    `Unknown log level ${JSON.stringify(level)}. ` +
      `Use one of: debug, info, warn, error, silent — or leave it unset for info.`,
  );
}

function consoleWrite(line: string, level: LogLevel): void {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Build a logger. Call it once, at boot, and pass the result to everything that logs.
 *
 *     const logger = createLogger({ level: process.env.LOG_LEVEL });
 *     logger.info("server started", { port: 3000 });
 *     logger.error("charge failed", { orderId, error: err });   // the RAW error, never String(err)
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const threshold = resolveThreshold(options.level);
  const write = options.write ?? consoleWrite;

  function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < threshold) return;
    // Canonical fields last, so they win: a meta `message`, `level` or `time` must never replace
    // the line's own label, severity or timestamp. One backend re-implemented this logger inline
    // with the order inverted, and a `meta.message` silently became the line.
    const time = new Date().toISOString();
    const entry = { ...meta, level, time, message };
    let line: string;
    try {
      line = JSON.stringify(entry, errorReplacer());
    } catch {
      // A logger must never take down the process it is reporting on. Reachable through a
      // throwing getter or a throwing `toJSON()` on something in `meta` — and the flag is there
      // so a reader knows a line was lost rather than never written.
      line = JSON.stringify({ level, time, message, logSerializationFailed: true });
    }
    write(line, level);
  }

  return {
    debug: (message, meta) => emit("debug", message, meta),
    info: (message, meta) => emit("info", message, meta),
    warn: (message, meta) => emit("warn", message, meta),
    error: (message, meta) => emit("error", message, meta),
  };
}

export { errorReplacer, keptErrorFields } from "./serialize.ts";
