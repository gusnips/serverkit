/**
 * The one error a route throws, and the one function that turns any thrown value into words.
 *
 * Extracted from six backends whose copies of this file are byte-identical in the parts that
 * matter: the envelope builder in four of them, `toMessage()` in six. Where they differ, the
 * version carrying the production reason won — every comment below names a failure somebody
 * shipped.
 *
 * Nothing here knows about the wire. That is deliberate and it is the fix to a live bug; see
 * the note on {@link AppError}.
 */

export interface AppErrorOptions<Key extends string = string> {
  /** What makes the refusal ACTIONABLE: the plan that lifts a 402, the scope of a quota. */
  details?: unknown;
  /**
   * The stable key a client localizes. Type it against your own closed list of keys, so a
   * typo'd or stale key is a compile error at the emit site rather than a raw dotted string
   * in front of a reader. The WIRE type stays `string`, so an older client tolerates a key
   * from a newer server and degrades to `message`.
   */
  messageKey?: Key;
  /** Interpolation values for `messageKey`. */
  params?: Record<string, string | number>;
  /**
   * How the refusal clears: seconds until the caller may retry, or `null` for a refusal that
   * waiting cannot fix.
   *
   * Set it HERE rather than hand-rolling it into `details`. `errorResponse` renders a number as
   * the standard `Retry-After` header AND folds it into `details`, so an HTTP client, a proxy
   * and your own SDK all learn the same wait from one value; `null` is folded in without a
   * header, because a `Retry-After` that states no time is worse than none.
   */
  retryAfterSecs?: number | null;
  /**
   * The `message` was authored for the client — a deployment fact like "payments are not set
   * up here", a named dependency that is down — so a 5xx keeps it instead of the generic
   * sentence. Never set it on a message built from a caught error: that is where driver text
   * lives, and one donor's whole masking policy exists because its repository layer
   * interpolates the driver's message into every failure it raises.
   */
  expose?: boolean;
  cause?: unknown;
}

/**
 * The one error type routes throw; {@link errorResponse} formats the envelope.
 *
 * `Code` is your product's error-code union and `Key` its message-key union. Neither is
 * shipped here: across six donors the factory tables hold 46 distinct code names and exactly
 * nine appear in all six. The codes are an API's vocabulary. What this package ships is the
 * shape, the wire format and the mask.
 *
 * Prefer {@link createAppError} over `new AppError(…)`: it reads the status off your own
 * code→status map, so no call site names a status and a code added without one is a build
 * error.
 *
 * Constructing one directly is the one path where a 429 with no wait is still representable:
 * the rule lives on the factory, because only the factory knows the map. That is the reason to
 * prefer it, not a style note.
 *
 * **There is no `toJSON()`, on purpose.** `JSON.stringify` calls a value's own `toJSON()`
 * BEFORE it calls the replacer, so a class that defines one never reaches a logger's `Error`
 * branch at all. Seven backends define one here, and every one of them logs
 * `{"error":{"error":{code,message}}}` — doubly nested, with no `stack` and no `cause` — from a
 * line that still looks like a log line. A logger cannot fix that from its side, because its
 * replacer never runs. So the wire body is built by `errorResponse`, where the mask lives
 * anyway, and this stays an ordinary Error to anything that serializes it.
 */
export class AppError<Code extends string = string, Key extends string = string> extends Error {
  public readonly statusCode: number;
  public readonly code: Code;
  public readonly details?: unknown;
  public readonly messageKey?: Key;
  public readonly params?: Record<string, string | number>;
  public readonly retryAfterSecs?: number | null;
  public readonly expose: boolean;

  constructor(statusCode: number, code: Code, message: string, opts: AppErrorOptions<Key> = {}) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = opts.details;
    this.messageKey = opts.messageKey;
    this.params = opts.params;
    this.retryAfterSecs = opts.retryAfterSecs;
    this.expose = opts.expose ?? false;
  }
}

/**
 * A map is widened to `Record<string, number>` unless it is declared `as const`, and a widened
 * map cannot tell a 429 from a 404 — so the rule below would silently stop applying. Refusing
 * the map is loud; accepting it with the guard switched off is the failure this package spends
 * a paragraph on everywhere else.
 *
 * It catches the HALF-widened map too, which is the realistic way this happens: one status read
 * from config turns `404 | number` into `number`, and the whole map loses its literals. The
 * property name is what the compiler prints, so it is plain ASCII — an arrow there comes out as
 * `\u2192` in the diagnostic, and the message is the entire point of the trick.
 */
type LiteralStatuses<S> = number extends S[keyof S]
  ? { "declare your code-to-status map as const": never }
  : S;

/**
 * Extra options a code's status makes mandatory.
 *
 * **A 429 states its own wait.** This is the highest-value line extracted from the whole
 * reading. One donor writes a `resetAt` ISO date that no HTTP client parses, and then needs a
 * hand-maintained list of "codes that do not clear by waiting" in its browser app to
 * compensate — its own comment says so. Another donor needs no such list, because every 429 it
 * sends states its wait, and a stated wait answers the question the list was guessing at. A
 * third raises a spent DAILY cap with no wait at all, on a code its client treats as transient,
 * so the browser retries a limit that clears at midnight — twice, immediately.
 *
 * Making it a required argument deletes that list from three repos and makes the retry bug
 * unrepresentable. Measured against the fleet it came from: of 40 places that raise a 429,
 * **34 already state a wait**, so the rule costs six edits in six repos.
 *
 * It is `[429] extends [Status]`, not `Status extends 429`, because the second form distributes:
 * a code narrowed to a UNION — off a lookup table, a switch, a value read from the wire —
 * produced a union of argument tuples, one of which had the options optional, and an empty
 * argument list satisfied it. The obligation vanished on exactly the shape that is hardest to
 * read. The tuples stop the distribution, and they ask the better question: does this code's
 * status set INCLUDE 429. A widened `number` then requires the wait everywhere rather than
 * nowhere, which is the safe direction to fail.
 *
 * Deliberately not extended to 503, and the same counting method is what settled it: of 94
 * raises of a 502/503/504 factory across six repos, **16 state a wait and 78 do not** — the
 * inverse of the 429 ratio. Most are "the database is unreachable" or "payments are not
 * configured here", which have no wait to state, so the rule would buy 78 `null`s and teach
 * people to type one without reading. The capability is there for the raiser that does know:
 * `retryAfterSecs` is on every code, a number renders `Retry-After` at any status, and an
 * explicit `null` says "durable" — which is the answer to a client that cannot otherwise tell
 * a 503 meaning "not configured on this deployment" from one meaning "did not answer just now".
 * Available, not compulsory.
 *
 * `null` is the other half, and the six are what proved it necessary. Two of them cannot state
 * a wait truthfully: a concurrency slot frees when somebody else's job finishes, and a cap on
 * live objects clears by archiving one, never by waiting at all. A required `number` would have
 * forced both to invent a number. `null` says "waiting cannot fix this" — which is the very
 * question the code lists were guessing at, answered by the one place that knows: the raiser.
 * An omission is invisible in a diff; a `null` is a claim somebody has to read.
 */
type RequiredOptions<Status, Key extends string> = [429] extends [Status]
  ? [opts: AppErrorOptions<Key> & { retryAfterSecs: number | null }]
  : [opts?: AppErrorOptions<Key>];

/**
 * Binds your code→status map, and returns the factory your `errors.*` table calls.
 *
 * ```ts
 * const ERROR_STATUS = {
 *   NOT_FOUND: 404,
 *   RATE_LIMIT_EXCEEDED: 429,
 * } as const satisfies Record<ErrorCode, number>;
 *
 * const appError = createAppError<typeof ERROR_STATUS, MessageKey>(ERROR_STATUS);
 *
 * export const errors = {
 *   notFound: (what = "Resource") => appError("NOT_FOUND", `${what} not found`),
 *   rateLimit: (retryAfterSecs: number) =>
 *     appError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfterSecs }),
 * };
 * ```
 *
 * The `satisfies` on your map is what makes a code with no status a build error — one line,
 * in your repo, and the only version of this that cannot drift. Three of the five newest
 * donors pass the status at every call site instead, which compiles no matter what.
 */
export function createAppError<S extends Record<string, number>, Key extends string = string>(
  statusOf: S & LiteralStatuses<S>,
): <C extends keyof S & string>(
  code: C,
  message: string,
  ...opts: RequiredOptions<S[C], Key>
) => AppError<C, Key> {
  return (code, message, ...opts) =>
    // A code with no status is a build error at your `satisfies`. One reaching here anyway —
    // a map assembled at runtime, a code narrowed off the wire — is our bug, not the caller's.
    new AppError(statusOf[code] ?? 500, code, message, opts[0]);
}

/**
 * `JSON.stringify` that never throws and never answers `"[object Object]"`.
 *
 * Private on purpose: it exists for {@link toMessage}'s last branch. A logger wants a richer
 * one (an allow-list over an error's own fields), which is a different function.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(value, (_key, val: unknown) => {
        if (val instanceof Error) return { name: val.name, message: val.message };
        if (typeof val === "bigint") return val.toString();
        if (typeof val === "object" && val !== null) {
          if (seen.has(val)) return "[Circular]";
          seen.add(val);
        }
        return val;
      }) ?? "null"
    );
  } catch {
    return "[unserializable]";
  }
}

/**
 * Turn any thrown value into a string.
 *
 * The single home for the `err instanceof Error ? err.message : String(err)` idiom, which is
 * wrong twice over and shipped that way in six repos:
 *
 * 1. A data layer rejects with a PLAIN OBJECT — `{code, message, hint}` is what PostgREST and
 *    several drivers throw — so the useful text is in `message` and `String()` never reads it.
 *    Six donors fixed this half.
 * 2. An object with no string `message` still flattens to `"[object Object]"`, which is the
 *    real failure masked by a useless string. One donor fixed that half and named it exactly:
 *    *"masking the real failure."* Its version is the one here.
 */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const { message } = err as { message?: unknown };
    if (typeof message === "string") return message;
    return safeStringify(err);
  }
  return String(err);
}
