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

  it("serializes a plain object with no message rather than flattening it", () => {
    const out = toMessage({ code: "PGRST205", hint: "run the migration" });
    expect(out).not.toBe("[object Object]");
    expect(out).toContain("PGRST205");
    expect(out).toContain("run the migration");
  });

  it("keeps a messageless object's diagnostic and drops the inputs hung beside it", () => {
    // The same allow-list the log serializer runs, and for the same reason one step later: this
    // string becomes an Error's message in `errorBoundary`, and a message is printed. An SDK that
    // rejects with the request it sent would otherwise put that request into the log through here.
    const out = toMessage({ code: "PGRST301", payload: '{"card":"4242424242424242"}' });

    expect(out).toContain("PGRST301");
    expect(out).not.toContain("4242");
  });

  it("names the keys of an object with nothing printable, rather than printing nothing", () => {
    // `{}` would be the "[object Object]" failure again in a new spelling: a useless string where
    // the real failure was. The key names come from the SDK, never from a caller, so they are the
    // one part of an unprintable object that identifies it.
    expect(toMessage({ payload: "the whole request body", header: "t=1,v1=deadbeef" })).toBe(
      "An object was thrown with no message. Its keys: payload, header.",
    );
  });

  it("survives a circular object", () => {
    const cycle: Record<string, unknown> = { code: "E_CYCLE" };
    cycle.self = cycle;
    expect(() => toMessage(cycle)).not.toThrow();
    expect(toMessage(cycle)).toContain("E_CYCLE");
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
