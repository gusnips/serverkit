import { describe, expect, it } from "vitest";
import { errorReplacer } from "./serialize.ts";

/** Serialize a log entry the way the logger does, and read the result back. */
function entryFor(meta: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(meta, errorReplacer())) as Record<string, unknown>;
}

/** Serialize one error under an `error` key and hand back what that key became. */
function serialized(err: unknown): Record<string, unknown> {
  return entryFor({ error: err }).error as Record<string, unknown>;
}

describe("what an Error contributes to a log line", () => {
  it("drops the webhook body and the signature a payment SDK hangs off its own error", () => {
    // The real shape, measured off the pinned SDK rather than imagined: a payment vendor's
    // signature-verification error has 25 own enumerable properties, and two of them are the
    // request the caller sent us — `payload` is the entire unparsed webhook body and `header` is
    // the signature it was checked against. The webhook route is unauthenticated by definition,
    // so the loop that copied all 25 let anyone on the internet choose what went into the log.
    // Named here for its shape rather than its origin; the field names ARE the evidence.
    const err = Object.assign(new Error("No signatures found matching the expected signature"), {
      type: "SignatureVerificationError",
      raw: { message: "No signatures found matching the expected signature" },
      rawType: undefined,
      detail: undefined,
      headers: { "connected-account": "acct_live_1", "idempotency-key": "idem_1" },
      requestId: "req_abc123",
      statusCode: 400,
      userMessage: undefined,
      advice_code: undefined,
      charge: "ch_1",
      code: undefined,
      decline_code: undefined,
      doc_url: undefined,
      network_advice_code: undefined,
      network_decline_code: undefined,
      param: undefined,
      payment_intent: { id: "pi_1", client_secret: "pi_1_secret_LEAKED" },
      payment_method: { id: "pm_1", card: { last4: "4242", exp_year: 2031 } },
      payment_method_type: "card",
      request_log_url: "https://dashboard.example.com/logs/req_abc123",
      setup_intent: undefined,
      source: undefined,
      user_message: undefined,
      header: "t=1700000000,v1=deadbeefdeadbeef",
      payload: '{"id":"evt_1","data":{"object":{"customer_email":"someone@example.com"}}}',
    });

    const line = JSON.stringify(serialized(err));

    expect(line).not.toContain("someone@example.com");
    expect(line).not.toContain("pi_1_secret_LEAKED");
    expect(line).not.toContain("4242");
    expect(line).not.toContain("acct_live_1");
    // toEqual, not a key check: the point is that nothing ELSE came along either.
    expect(serialized(err)).toEqual({
      name: "Error",
      message: "No signatures found matching the expected signature",
      // `type` earns its place here: this vendor never sets `name`, so without it every one of
      // its failures reads as a bare "Error" in the log.
      type: "SignatureVerificationError",
      statusCode: 400,
      stack: err.stack,
    });
  });

  it("drops the password a Redis client hangs off a failed AUTH", () => {
    // A Redis client attaches `command = { name, args }` to a server-returned error, and an AUTH
    // failure routes through that assignment — so the line an operator reads to find out why
    // Redis is refusing them carried the credential that was refused.
    const err = Object.assign(new Error("WRONGPASS invalid username-password pair"), {
      command: { name: "auth", args: ["default", "hunter2-the-real-password"] },
    });

    expect(JSON.stringify(serialized(err))).not.toContain("hunter2");
  });

  it("drops the statement text Postgres hangs off a constraint violation", () => {
    // Reproduced against Postgres 18: a CHECK violation raised inside a PL/pgSQL function sets
    // `where` to the failing statement, literals included. pg is in every backend here, so this
    // is the copy-loop's third vendor and the only one that is not optional.
    const err = Object.assign(new Error("new row violates check constraint"), {
      code: "23514",
      severity: "ERROR",
      constraint: "probe_card_ck",
      schema: "public",
      table: "probe_t",
      where:
        'SQL statement "INSERT INTO probe_t (email, card) ' +
        "VALUES ('someone@example.com', '4242424242424242')\"\nPL/pgSQL function probe_fn() line 3",
      internalQuery: "INSERT INTO probe_t (email, card) VALUES ('someone@example.com', '4242…')",
      routine: "ExecConstraints",
      file: "execMain.c",
      line: "2081",
    });

    const line = serialized(err);

    expect(JSON.stringify(line)).not.toContain("someone@example.com");
    expect(JSON.stringify(line)).not.toContain("4242");
    expect(line).toMatchObject({ code: "23514", severity: "ERROR", constraint: "probe_card_ck" });
  });

  it("keeps the Postgres DETAIL that names the key, and drops the one that is the whole row", () => {
    // Two message forms, one field. A unique violation names only the key columns, which is the
    // diagnostic this field is kept for. A CHECK or NOT NULL violation writes the ENTIRE failing
    // row — every column, whatever the table holds. Both strings are verbatim from Postgres 18.
    const unique = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      detail: "Key (slug)=(demo) already exists.",
      constraint: "boards_slug_key",
    });
    expect(serialized(unique).detail).toBe("Key (slug)=(demo) already exists.");

    const check = Object.assign(new Error("new row violates check constraint"), {
      code: "23514",
      detail: "Failing row contains (someone@example.com, 4242424242424242).",
    });
    const line = serialized(check);
    expect(JSON.stringify(line)).not.toContain("someone@example.com");
    // Not silence: the reader is told a DETAIL existed and why it is not here.
    expect(String(line.detail)).toContain("row omitted");
  });

  it("drops the rejected input a zod 3 validation error echoes back", () => {
    // Measured: in zod 3 `issues` is an own enumerable property and an issue can carry the value
    // that was rejected (`received: "…"`), so the copy loop wrote caller input into the log. In
    // zod 4 it is non-enumerable and never rode along at all — so dropping it costs nothing on
    // the version this fleet runs, and is a fix on the version it does not.
    const err = Object.assign(new Error("invalid input"), {
      name: "ZodError",
      issues: [{ code: "invalid_enum_value", path: ["role"], received: "SUPER-SECRET-VALUE" }],
    });

    expect(JSON.stringify(serialized(err))).not.toContain("SUPER-SECRET-VALUE");
  });

  it("keeps what a Postgres failure has to say", () => {
    // Why the extras ride along at all: without `code` a unique violation is indistinguishable
    // from a syntax error, and `constraint` is what names which uniqueness was violated.
    const err = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      detail: "Key (slug)=(demo) already exists.",
      hint: "Pick another slug.",
      constraint: "workspaces_slug_key",
      severity: "ERROR",
    });

    expect(serialized(err)).toMatchObject({
      code: "23505",
      detail: "Key (slug)=(demo) already exists.",
      hint: "Pick another slug.",
      constraint: "workspaces_slug_key",
      severity: "ERROR",
    });
  });

  it("keeps the fields our own error classes carry", () => {
    const err = Object.assign(new Error("too many requests"), {
      code: "QUOTA_EXCEEDED",
      statusCode: 429,
      status: 429,
      messageKey: "errors.QUOTA_EXCEEDED",
      params: { plan: "free" },
      retryAfterSecs: 60,
      retryAfter: 60,
      kind: "rate-limit",
      retryable: false,
    });

    expect(serialized(err)).toMatchObject({
      code: "QUOTA_EXCEEDED",
      statusCode: 429,
      status: 429,
      messageKey: "errors.QUOTA_EXCEEDED",
      params: { plan: "free" },
      retryAfterSecs: 60,
      retryAfter: 60,
      kind: "rate-limit",
      retryable: false,
    });
  });

  it("follows the cause chain, and allow-lists every link of it", () => {
    // `cause` is non-enumerable, so it is invisible to the loop above and has to be added by
    // hand. Each link goes back through the replacer, so a vendor error buried three deep is
    // filtered the same as one at the top.
    const root = Object.assign(new Error("WRONGPASS invalid username-password pair"), {
      code: "WRONGPASS",
      command: { name: "auth", args: ["default", "hunter2-the-real-password"] },
    });
    const middle = new Error("cache unavailable", { cause: root });
    const top = new Error("could not load the board", { cause: middle });

    const line = serialized(top);
    const cause = line.cause as Record<string, unknown>;
    const deeper = cause.cause as Record<string, unknown>;

    expect(cause.message).toBe("cache unavailable");
    expect(deeper.code).toBe("WRONGPASS");
    expect(JSON.stringify(line)).not.toContain("hunter2");
  });

  it("shows what an AggregateError aggregated", () => {
    // `errors` is non-enumerable too, so without this line the whole log entry for a failed
    // Promise.any is the word "all failed". Each sub-error is allow-listed like any other.
    const agg = new AggregateError(
      [
        Object.assign(new Error("primary refused"), { code: "ECONNREFUSED", port: 6379 }),
        Object.assign(new Error("replica refused"), { code: "ECONNREFUSED" }),
      ],
      "every cache endpoint refused",
    );

    const line = serialized(agg);
    const errors = line.errors as Array<Record<string, unknown>>;

    expect(line.message).toBe("every cache endpoint refused");
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ message: "primary refused", code: "ECONNREFUSED" });
    // `port` is not on the list: nothing in twelve backends reads it off a caught error.
    expect(errors[0]).not.toHaveProperty("port");
  });

  it("survives a circular reference instead of crashing the log call", () => {
    // Both shapes: an error that is its own cause, and a plain object that holds itself. A
    // JSON.stringify with neither guard throws, inside the log call, which is how a logger takes
    // down the process it was reporting on.
    const err = new Error("cycle");
    err.cause = err;
    const job: Record<string, unknown> = { id: "job_1" };
    job.parent = job;

    const entry = entryFor({ error: err, job });

    expect((entry.error as Record<string, unknown>).cause).toBe("[Circular]");
    expect((entry.job as Record<string, unknown>).parent).toBe("[Circular]");
  });

  it("stringifies a bigint instead of throwing", () => {
    // JSON.stringify refuses a bigint outright ("Do not know how to serialize a BigInt"), so
    // one row count off a driver that returns them would end the log call.
    expect(entryFor({ rows: 9007199254740993n }).rows).toBe("9007199254740993");
  });
});
