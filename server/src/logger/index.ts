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

/**
 * What a line carries beside its message. An `Error` passed on its own is written under `error`,
 * the same as `{ error: err }`.
 */
export type LogMeta = Record<string, unknown> | Error;

export interface Logger {
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
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
  /**
   * More to hide, on top of what is always hidden. See {@link RedactOptions}.
   *
   * There is no way to turn the defaults off. A bearer token, a password in a database URL or an
   * `Authorization` header in a log line is never what anybody wanted.
   */
  redact?: RedactOptions;
}

export interface RedactOptions {
  /** A key whose value is replaced whole, at any depth: `/cpf$/i`. Checked beside the default. */
  keys?: RegExp;
  /**
   * A pattern replaced in every string on the line: the message, every value, and an error's
   * message and stack. Each one needs the `g` flag, and it runs after the defaults:
   * `[/\bacme_[\w-]+/g, "[redacted]"]`.
   */
  values?: ReadonlyArray<readonly [pattern: RegExp, replacement: string]>;
}

const REDACTED = "[redacted]";

/**
 * A key whose value never reaches a line. Two backends wrote this rule independently, and both
 * matched the words ANYWHERE in the key. Measured across the fleet's logger calls, that hides 11
 * fields in 6 repos and not one of them is a secret: `apiKeyId` (which key made the request),
 * `tokenId`, two booleans saying whether a secret was set, and five token counts. The same
 * calls log no key that does hold a secret, so this rule is a guard for the object nobody meant
 * to log whole, like a request's headers. Matching at the END of the key keeps all 11 and still
 * catches `authorization`, `set-cookie`, `newPassword`, `clientSecret`, `accessToken`,
 * `x-api-key` and `secretAccessKey`.
 *
 * A plural is caught too, except `token`'s. Anchoring at the end is what let `freeApiKeys`, an
 * array of real provider keys in one backend, slip past where the match-anywhere rule had caught
 * it. And a `…Tokens` key in the fleet's logs is always a count (`inputTokens`, `maxTokens`), so
 * that one plural stays out.
 */
const SECRET_KEY =
  /(?:authorization|cookies?|passwords?|secrets?|token|(?:api|access|secret|private)[_-]?keys?)$/i;

/** Patterns replaced in every string. Both are credentials wherever they appear. */
const SECRET_VALUES: ReadonlyArray<readonly [RegExp, string]> = [
  // An `Authorization` value pasted into a message or an error. It stops at a comma or a
  // semicolon, so the rest of a header list survives.
  [/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`],
  // `user:password@` in any URL. A database URL inside a connection error is the usual one.
  [/\b([a-z][a-z\d+.-]*:\/\/)[^\s/?#]+@/gi, `$1${REDACTED}@`],
];

type Replacer = (this: unknown, key: string, value: unknown) => unknown;

function redactor({ keys, values = [] }: RedactOptions = {}) {
  for (const [pattern] of values) {
    // Loud at construction, like an unknown level: without `g`, `replace` hides only the first
    // match in each string, and the second copy of the secret is printed.
    if (!pattern.global) {
      throw new Error(`redact.values: ${String(pattern)} needs the g flag to hide every match.`);
    }
  }
  const patterns = [...SECRET_VALUES, ...values];
  const text = (value: string) =>
    patterns.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), value);
  // `search`, not `test`: `test` on a `g` regex resumes from `lastIndex`, so the same key would
  // be hidden on one line and printed on the next.
  const secretKey = (key: string) =>
    SECRET_KEY.test(key) || (keys !== undefined && key.search(keys) !== -1);

  return {
    text,
    /** Wraps a replacer. The key is checked first, so a secret never reaches the serializer. */
    replacer(inner: Replacer): Replacer {
      return function (key, value) {
        if (value !== undefined && secretKey(key)) return REDACTED;
        const out = inner.call(this, key, value);
        return typeof out === "string" ? text(out) : out;
      };
    },
  };
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
  const redact = redactor(options.redact);

  function emit(level: LogLevel, message: string, meta?: LogMeta): void {
    if (LEVELS[level] < threshold) return;
    // An Error's message and stack are not enumerable, so spread as the whole of `meta` it would
    // leave a line that says nothing about what failed. `.catch((err) => logger.error("…", err))`
    // is the shape that does it, and `err` is `any` there, so no type ever caught it.
    const fields = meta instanceof Error ? { error: meta } : meta;
    // Canonical fields last, so they win: a meta `message`, `level` or `time` must never replace
    // the line's own label, severity or timestamp. One backend re-implemented this logger inline
    // with the order inverted, and a `meta.message` silently became the line.
    const time = new Date().toISOString();
    let line: string;
    try {
      // The spread is inside the `try` because it runs `meta`'s own getters.
      line = JSON.stringify({ ...fields, level, time, message }, redact.replacer(errorReplacer()));
    } catch {
      // A logger must never take down the process it is reporting on. Reachable through a
      // throwing getter or a throwing `toJSON()` on something in `meta` — and the flag is there
      // so a reader knows a line was lost rather than never written.
      line = JSON.stringify({
        level,
        time,
        message: redact.text(message),
        logSerializationFailed: true,
      });
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
