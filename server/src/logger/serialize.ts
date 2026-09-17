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
 * A `JSON.stringify` replacer that keeps log lines useful and crash-proof:
 *
 * - Errors serialize to a readable object. `message` and `stack` are non-enumerable, so a plain
 *   `JSON.stringify(err)` is `{}` — which is how a logger ends up printing nothing about the
 *   failure it was called to report. They are added explicitly, and the allow-listed extras ride
 *   along beside them.
 * - A nested `cause` is followed, and so is an `AggregateError`'s `errors`. Both are
 *   non-enumerable, so both are invisible to the loop above; without this line "all attempts
 *   failed" is the whole log entry. Each one goes back through this replacer, so the allow-list
 *   covers the chain, not just the top.
 * - bigints stringify instead of throwing.
 * - Circular references collapse to "[Circular]" instead of crashing the log call.
 *
 * Paired with callers passing the RAW error rather than `String(err)`, this is why a log line
 * never reads "[object Object]".
 *
 * One ordering fact worth knowing, because it decides what this replacer ever sees: `JSON.stringify`
 * calls a value's own `toJSON()` **before** the replacer. An error class that defines `toJSON()`
 * therefore serializes through that method and never reaches the branch below — stack included.
 *
 * A new replacer per log line, because the `seen` set must not outlive one entry.
 */
export function errorReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Error) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
      const out: Record<string, unknown> = { name: value.name, message: value.message };
      for (const [k, v] of Object.entries(value)) {
        if (KEPT_ERROR_FIELDS.has(k)) out[k] = keptValue(k, v);
      }
      const { cause } = value;
      if (cause !== undefined) out.cause = cause;
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
