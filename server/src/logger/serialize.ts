/**
 * The error serializer. This is the one file in `@gusnips/server` that exists because of an
 * incident rather than because of duplication.
 *
 * Six backends shipped the same replacer, and it copied **every own enumerable property** off a
 * caught Error into the log line. The comment beside the loop said it was there to pick up a
 * Postgres `code`/`detail`/`hint`. What it actually picked up was whatever the SDK that threw had
 * hung on the error — which for two vendors in use is the request the caller sent us.
 */

/**
 * The own enumerable properties a log line keeps off an Error. An ALLOW-list, not a deny-list,
 * because an SDK hangs its own INPUTS off the error it throws, and the list of words vendors use
 * for that is open-ended:
 *
 * - **A payment SDK.** Its signature-verification error carries `payload` — the entire unparsed
 *   webhook body — and `header`, the signature it was checked against. Measured on the pinned
 *   version: that error has **25 own enumerable properties** and this list admits **4** of them
 *   (`type`, `code`, `detail`, `statusCode`). Among the 21 dropped are `raw` (the whole error body)
 *   and `headers`. A webhook route is unauthenticated by definition, so the old loop let anyone on
 *   the internet write content of their choosing into the log by POSTing a junk signature.
 * - **A Redis client.** A server-returned error carries `command = { name, args }`. On an AUTH
 *   failure those args are the password — written to stdout at the exact moment an operator is
 *   reading the log to find out why Redis is refusing them.
 * - **Postgres.** A `DatabaseError` carries `where` and `internalQuery`, which hold **statement
 *   text with its literals in it**. Reproduced against Postgres 18: a CHECK violation raised inside
 *   a PL/pgSQL function set `where` to the failing INSERT, e-mail address and card number included.
 *   pg is in every backend here, so this one was never vendor-specific.
 *
 * A deny-list would have had to know `payload`, `header`, `raw`, `command`, `where` and the next
 * vendor's word for it, and it learns each one from an incident. This list only has to know ours.
 *
 * **Add a key when our own code reads it off a caught error.** Two on it have no reader and say so
 * below; everything else was measured across twelve backends.
 */
const KEPT_ERROR_FIELDS: ReadonlySet<string> = new Set([
  // Postgres and PostgREST diagnostics. `detail` is the pg driver's spelling, `details`
  // PostgREST's. `hint` has no reader anywhere in the fleet — it is kept because the donor
  // comment promises it by name and a Postgres HINT never carries a value, only a suggestion.
  "code",
  "detail",
  "details",
  "hint",
  "constraint",
  "severity",
  // Our own error classes, and the classified failures the modules throw.
  "statusCode",
  "status",
  "messageKey",
  "params",
  "retryAfterSecs",
  // The same number under an SDK's spelling. Our house word is `retryAfterSecs`; one SDK in the
  // fleet says `retryAfter`, and two call sites read it off the caught error — so without this a
  // rate-limit line says it was rate-limited and not for how long.
  "retryAfter",
  "kind",
  "retryable",
  // Which vendor error this was. One vendor sets `type` and never sets `name`, so without this
  // every failure from it logs as a bare "Error". Read off the SDK, not guessed.
  "type",
]);

/**
 * Postgres writes the **entire failing row** into DETAIL for a CHECK or NOT NULL violation —
 * every column of it, whatever that table happens to hold. Measured against Postgres 18:
 *
 *     detail: "Failing row contains (someone@example.com, 4242424242424242)."
 *
 * That is the one value-level rule in this file, and it is here rather than in a redaction pass
 * because it is not a pattern over arbitrary text: it is one exact message form, and Postgres is
 * the only thing that writes it. The unique-violation form — `Key (slug)=(demo) already exists.` —
 * names only the key columns, which is the diagnostic this field is kept for, and survives.
 */
const PG_FAILING_ROW = "Failing row contains (";
const OMITTED_ROW = "[row omitted: Postgres DETAIL for this error is the whole failing row]";

function keptValue(key: string, value: unknown): unknown {
  if ((key === "detail" || key === "details") && typeof value === "string") {
    return value.startsWith(PG_FAILING_ROW) ? OMITTED_ROW : value;
  }
  return value;
}

/**
 * A thrown value that is NOT an Error, narrowed to what a log line may print off it.
 *
 * The allow-list above is written against Errors, and until this the narrowing stopped there: an
 * Error was filtered and whatever sat in its `cause` was copied whole. That gap is not theoretical
 * here, it is this package's own doing — `errorBoundary` turns every non-Error throw into
 * `new Error(toMessage(err), { cause: err })`, because Hono's `onError` never sees a non-Error and
 * a PostgREST client rejects with plain objects. So in a Hono app the cause slot is precisely where
 * a vendor's rejection object ends up, and a leak there reads as if the list had run.
 *
 * A plain object passed directly as `meta.error` is the other door. Hono wraps it, but a worker,
 * a fire-and-forget catch or a database client outside Hono does not. `error` is the raw-error slot
 * the logger documents, so it gets the same treatment as `cause`; an ordinary metadata object under
 * any other key stays untouched. `name`, `message` and `stack` come along because a rejection
 * object usually carries them and a line with none of them says nothing at all.
 *
 * `stack` is here because an adopter's queue found it missing. A job that dies is stored by its
 * queue through a serializer, so the error reaching the dead-letter handler is a plain object with
 * its stack in a string — and that stack is the whole of the "why" in a line whose job is to say
 * which job died and why. The Error branch below has always written `stack` unfiltered; leaving it
 * out here was an asymmetry, not a decision. It is a conventional field name, not one an SDK hangs
 * its own inputs off, which is what the allow-list exists to stop.
 *
 * Deliberate state it does NOT keep: context an app attaches on purpose. That belongs in the
 * logger's `meta`, which is untouched — `cause` is not the place for it, and one incident of a
 * vendor's request body in the log outweighs a field nobody put there deliberately.
 */
export function narrowErrorLike(value: object): Record<string, unknown> {
  return narrow(value, new WeakSet<object>());
}

function narrow(value: object, seen: WeakSet<object>): Record<string, unknown> {
  seen.add(value);
  const out: Record<string, unknown> = {};
  const { name, message, stack, cause } = value as {
    name?: unknown;
    message?: unknown;
    stack?: unknown;
    cause?: unknown;
  };
  if (typeof name === "string") out.name = name;
  if (typeof message === "string") out.message = message;
  if (typeof stack === "string") out.stack = stack;
  for (const [k, v] of Object.entries(value)) {
    if (KEPT_ERROR_FIELDS.has(k)) out[k] = keptValue(k, v);
  }
  if (cause !== undefined) out.cause = narrowCause(cause, seen);
  return out;
}

/**
 * An Error cause goes back unchanged, because `JSON.stringify` walks it into the replacer's own
 * Error branch. Anything that is not an object is a string or a number, which is its own value.
 */
function narrowCause(cause: unknown, seen: WeakSet<object>): unknown {
  if (cause instanceof Error || typeof cause !== "object" || cause === null) return cause;
  // The recursion builds new objects, so the replacer's `seen` cannot see this chain: a rejection
  // that holds itself would recurse until the stack ends, inside the one call that must never take
  // the process down.
  return seen.has(cause) ? "[Circular]" : narrow(cause, seen);
}

/**
 * A `JSON.stringify` replacer that keeps log lines useful and crash-proof:
 *
 * - Errors serialize to a readable object. `message` and `stack` are non-enumerable, so a plain
 *   `JSON.stringify(err)` is `{}` — which is how a logger ends up printing nothing about the
 *   failure it was called to report. They are added explicitly, and the allow-listed extras ride
 *   along beside them.
 * - A plain object in the root `error` slot is narrowed through the same allow-list. Hono's
 *   boundary turns one into an Error cause, but workers and swallowed catches log it directly.
 *   Other metadata objects stay untouched.
 * - A nested `cause` is followed, and so is an `AggregateError`'s `errors`. Both are
 *   non-enumerable, so both are invisible to the loop above; without this line "all attempts
 *   failed" is the whole log entry. Each one goes back through this replacer, so the allow-list
 *   covers the chain, not just the top — and a cause that is not an Error is narrowed here
 *   instead, by {@link narrowErrorLike}, because the replacer's Error branch would never see it.
 * - bigints stringify instead of throwing.
 * - Circular references collapse to "[Circular]" instead of crashing the log call.
 *
 * Paired with callers passing the RAW error rather than `String(err)`, this is why a log line
 * never reads "[object Object]".
 *
 * One ordering fact decides what this replacer would otherwise see: `JSON.stringify` calls a
 * value's own `toJSON()` **before** the replacer, so an error class that defines one arrives here
 * already turned into whatever that method returns — the stack and the cause gone, and the result
 * usually shaped for the WIRE, because that is what an error's `toJSON()` is for. Seven backends
 * on this stack define one, and `logger.error("x", { error: appErr })` wrote
 * `{"error":{"error":{…}}}` in every one of them: double-nested, no stack, no cause, and
 * invisible, because the line still looks like a log line.
 *
 * The original is still there. `JSON.stringify` calls the replacer with the HOLDER as `this`, and
 * the holder's own property is the untouched value — so `this[key]` recovers the Error that
 * `toJSON()` replaced. That is why this is a `function` and not an arrow.
 *
 * What a log line keeps off an Error is this file's decision, not the error's: an error class is
 * free to define the body it sends a client, and the log still gets name, message, stack, cause
 * and the allow-list.
 *
 * A new replacer per log line, because the `seen` set must not outlive one entry.
 */
export function errorReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  let root: object | undefined;
  return function (key, value) {
    const held =
      typeof this === "object" && this !== null
        ? (this as Record<string, unknown>)[key]
        : undefined;
    if (key === "" && typeof held === "object" && held !== null) root = held;
    if (held instanceof Error) value = held;
    else if (this === root && key === "error" && typeof held === "object" && held !== null) {
      return seen.has(held) ? "[Circular]" : narrow(held, seen);
    }
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const out: Record<string, unknown> = { name: value.name, message: value.message };
      for (const [k, v] of Object.entries(value)) {
        if (KEPT_ERROR_FIELDS.has(k)) out[k] = keptValue(k, v);
      }
      const { cause } = value;
      if (cause !== undefined) out.cause = narrowCause(cause, seen);
      if (value instanceof AggregateError) out.errors = value.errors;
      if (value.stack) out.stack = value.stack;
      return out;
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  };
}

/** The keys an Error may contribute to a log line, beside `name`, `message`, `stack` and `cause`. */
export const keptErrorFields: ReadonlySet<string> = KEPT_ERROR_FIELDS;
