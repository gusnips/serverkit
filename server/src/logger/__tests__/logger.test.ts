import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, type LogLevel } from "../index.ts";

function capture() {
  const lines: Array<{ level: LogLevel; entry: Record<string, unknown> }> = [];
  const write = (line: string, level: LogLevel) =>
    lines.push({ level, entry: JSON.parse(line) as Record<string, unknown> });
  return { lines, write };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the log line", () => {
  it("is one JSON object with level, time and message on it", () => {
    const { lines, write } = capture();
    createLogger({ write }).info("server started", { port: 3000 });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.entry).toMatchObject({ level: "info", message: "server started", port: 3000 });
    expect(new Date(String(lines[0]!.entry.time)).toISOString()).toBe(lines[0]!.entry.time);
  });

  it("lets the canonical fields win over a meta key of the same name", () => {
    // A `meta.message` must never become the line's label. One backend re-implemented this
    // logger inline with the spread the other way round, and a meta `message` silently replaced
    // the line it was attached to.
    const { lines, write } = capture();
    createLogger({ write }).warn("quota check failed", {
      message: "the caller's own text",
      level: "debug",
      time: "not a time",
    });

    expect(lines[0]!.entry).toMatchObject({
      level: "warn",
      message: "quota check failed",
    });
    expect(lines[0]!.entry.time).not.toBe("not a time");
  });
});

describe("a logger that cannot serialize a line", () => {
  it("writes a flagged line instead of throwing", () => {
    // A logger must never take down the process it was called to report on. Reachable through a
    // throwing getter or a throwing `toJSON()` on anything in `meta` — and the flag is there so
    // a reader knows a line was lost rather than never written.
    const hostile = {
      toJSON() {
        throw new Error("no");
      },
    };

    const { lines, write } = capture();
    createLogger({ write }).error("charge failed", { hostile });

    expect(lines).toHaveLength(1);
    expect(lines[0]!.entry).toMatchObject({
      level: "error",
      message: "charge failed",
      logSerializationFailed: true,
    });
  });
});

describe("the level", () => {
  it("defaults to info, so debug is dropped and warn is kept", () => {
    const { lines, write } = capture();
    const logger = createLogger({ write });
    logger.debug("noise");
    logger.info("kept");
    logger.warn("kept");
    logger.error("kept");

    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  it("comes from the caller, never from the environment", () => {
    // The whole reason this is an argument: `.` has to import cleanly inside a Cloudflare
    // Worker, which has no `process` at all. A module-scope `process.env.LOG_LEVEL` read makes
    // the package Node-only by accident, and nothing in a type or a test would say so.
    const { lines, write } = capture();
    createLogger({ level: "debug", write }).debug("now visible");

    expect(lines).toHaveLength(1);
  });

  it("writes nothing at all when it is silent", () => {
    // What a test suite sets, so an injected failure does not print a real-looking error line
    // and bury the one real failure. It is a threshold, not a level: nothing logs AT silent.
    const { lines, write } = capture();
    const logger = createLogger({ level: "silent", write });
    logger.debug("x");
    logger.error("x");

    expect(lines).toHaveLength(0);
  });

  it("treats an unset or empty level as info", () => {
    // `process.env.LOG_LEVEL` is `undefined` when unset and "" when set to nothing, and both
    // mean the same thing to the person who typed them.
    const { lines, write } = capture();
    createLogger({ level: undefined, write }).info("a");
    createLogger({ level: "", write }).info("b");

    expect(lines).toHaveLength(2);
  });

  it("refuses an unknown level at boot, and names the ones that work", () => {
    // Loud here rather than a silent fall back to info: a box running at the wrong level is
    // discovered during the incident it was supposed to explain. This runs once, at boot, so a
    // typo fails the deploy instead of the 3am read.
    expect(() => createLogger({ level: "verbose" })).toThrow(/verbose/);
    expect(() => createLogger({ level: "verbose" })).toThrow(/debug, info, warn, error, silent/);
  });
});

describe("where a line goes", () => {
  it("sends error and warn to stderr and the rest to stdout", () => {
    // The process manager reading these keeps stdout and stderr apart, and a crash that only
    // reaches stderr is the thing the structured log exists to replace.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createLogger({ level: "debug" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");

    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});
