import { describe, expect, it } from "vitest";
import { AppError, toMessage } from "./errors.ts";

describe("toMessage", () => {
  it("reads an Error's message", () => {
    expect(toMessage(new Error("boom"))).toBe("boom");
  });

  it("reads a string message off a plain object", () => {
    expect(toMessage({ code: "23505", message: "duplicate key value" })).toBe(
      "duplicate key value",
    );
  });

  it("returns a string as itself", () => {
    expect(toMessage("just a string")).toBe("just a string");
  });

  it("names the code of a plain object with no message, and nothing else off it", () => {
    // Not "[object Object]", which masks the failure, and not the whole object either: this
    // string becomes an Error's message, and a message reaches the log past every allow-list.
    const thrown = { code: "PGRST205", hint: "run the migration", query: "where card = '4242'" };

    expect(toMessage(thrown)).toBe("A thrown object with no message (code PGRST205)");
    expect(toMessage({ code: 42501 })).toBe("A thrown object with no message (code 42501)");
  });

  it("says only that there was no message when there is no code either", () => {
    expect(toMessage({ card: "4242424242424242" })).toBe("A thrown object with no message");
    expect(toMessage([1, 2])).toBe("A thrown object with no message");
  });

  it("falls back to String() for a primitive", () => {
    expect(toMessage(null)).toBe("null");
    expect(toMessage(42)).toBe("42");
  });
});

describe("an AppError is an ordinary Error to anything that serializes it", () => {
  /**
   * `JSON.stringify` calls a value's own `toJSON()` BEFORE it calls the replacer, so a class
   * that defines one never reaches a logger's Error branch at all. Seven backends define
   * `toJSON()` on this class, so `logger.error("x", { error: appErr })` writes a doubly-nested
   * envelope with no `stack` and no `cause` — live in all seven, and invisible because the line
   * still looks like a log line. The wire body is built by `errorResponse`; the error stays an
   * error.
   */
  function serializeLikeALogger(value: unknown): { json: string; sawError: boolean } {
    let sawError = false;
    const json = JSON.stringify(value, (_key, val: unknown) => {
      if (val instanceof Error) {
        sawError = true;
        return { name: val.name, message: val.message, stack: val.stack, cause: val.cause };
      }
      return val;
    });
    return { json, sawError };
  }

  it("reaches the replacer's Error branch, with its stack and its cause", () => {
    const cause = new Error("connection refused");
    const err = new AppError(500, "INTERNAL_ERROR", "the write failed", { cause });
    const { json, sawError } = serializeLikeALogger({ error: err });
    expect(sawError).toBe(true);
    expect(json).toContain("the write failed");
    expect(json).toContain("connection refused");
    expect(json).toContain('"stack"');
  });

  it("defines no toJSON, so nothing can shadow that branch", () => {
    const err = new AppError(500, "INTERNAL_ERROR", "boom");
    expect("toJSON" in err).toBe(false);
  });
});
