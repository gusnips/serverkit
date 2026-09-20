/**
 * How a backend answers: the success envelope, and the one function that turns a thrown thing
 * into an HTTP answer.
 *
 * Nothing here knows about a framework, and that is a measurement rather than a preference.
 * Five backends put this logic inside one `app.onError`, and then **three of them re-derived
 * the same two arms inside an MCP tool wrapper** so an agent would get a real refusal instead
 * of "an unexpected error occurred". A fourth re-derived the error body inside a background
 * worker's health handler and got it wrong, answering a caught Redis message on a 503 — the
 * API next door masks exactly that. A `Context`-shaped function would serve one of those four
 * callers. The framework adapter is eight lines and lives in `/hono`.
 */
import type { ApiError, ApiSuccess, PaginationMeta } from "@gusnips/http";
import { AppError } from "./errors.ts";

/** Every 2xx body is `{ data }`, or `{ data, meta }` where a route has counts to report. */
export function ok<T, M = PaginationMeta>(data: T, meta?: M) {
  const body: ApiSuccess<T, M> = meta === undefined ? { data } : { data, meta };
  return { status: 200 as const, body };
}

export function created<T>(data: T) {
  const body: ApiSuccess<T> = { data };
  return { status: 201 as const, body };
}

/**
 * `hasMore` is computed from the page that was actually returned, not from `limit`: a page cut
 * short by a filter still has to answer the question honestly. Identical, to the field, in five
 * donors.
 */
export function paginated<T>(rows: T[], meta: Omit<PaginationMeta, "hasMore">) {
  const body: ApiSuccess<T[]> = {
    data: rows,
    meta: { ...meta, hasMore: meta.offset + rows.length < meta.total },
  };
  return { status: 200 as const, body };
}

export function noContent() {
  return { status: 204 as const, body: null };
}

export interface ErrorAnswer<Code extends string = string> {
  status: number;
  body: ApiError<Code>;
  /** `Retry-After` when the refusal states a wait; `WWW-Authenticate` on a 401. */
  headers: Record<string, string>;
  /**
   * What kind of failure this was, which is the one thing a caller cannot work out from the
   * status. A 500 raised on purpose and a `TypeError` that escaped are both 500s, and only the
   * second one means nobody is watching a log for it — every donor fires its admin alert on
   * exactly that branch.
   */
  kind: "client" | "server" | "unexpected";
}

/** The envelope a masked 5xx, an unexpected throw, or a refused body is answered with. */
export interface CannedError<Code extends string, Key extends string> {
  code: Code;
  /** English, for logs, `curl` and agents. A client localizes from `messageKey`. */
  message: string;
  messageKey?: Key;
}

export interface ErrorResponseOptions<Code extends string, Key extends string> {
  /** Answers a masked 5xx and anything that escaped. */
  internal: CannedError<Code, Key>;
  /** Answers a validation failure. */
  validation: CannedError<Code, Key>;
  /**
   * The 5xx codes whose message is replaced. Defaults to `["INTERNAL_ERROR"]`, which is what
   * four of the five newest donors do, and their reason is worth keeping: flattening a
   * `GATEWAY_ERROR` or a `SERVICE_UNAVAILABLE` into a generic 500 "would take away the one
   * thing that tells a developer whether to retry."
   *
   * **That default is safe because of your call sites, not because of this code.** It holds
   * only while every non-masked 5xx is handed a message somebody wrote for the client. A repo
   * whose repository layer interpolates the driver's error into the message it raises — one
   * donor's does, deliberately, so that duplicate-key heuristics keep working — wants
   * `maskAll` instead.
   */
  maskedCodes?: readonly Code[];
  /** Replace every 5xx message, and let `expose` be what opts an authored sentence back in. */
  maskAll?: boolean;
  /**
   * Drop `details` from a 5xx whose message you did NOT mask — a separate knob because it is a
   * separate decision. The newest donors put a readiness report in a 503's details, naming
   * which dependency is down so a deploy gate and a human at 3am can both read it; another
   * donor's details are where caught error text is recorded, and must never go out. Both are
   * right about their own repo, which is why this is not folded into the mask above. (A masked
   * 5xx drops its details on its own: the body is built fresh from `internal`.)
   *
   * The sharpest reason to turn it on is a caught driver error handed straight to `details`.
   * On a CHECK or NOT NULL violation Postgres writes the ENTIRE failing row into its `detail`
   * field — `Failing row contains (someone@example.com, 4242…)`, every column, values
   * included. Measured against a real server, not assumed.
   */
  maskDetails?: boolean;
}

/**
 * `retryAfterSecs` also rides inside `details`, because that is where clients already look —
 * an explicit `null` included, since "waiting cannot fix this" is an answer a client needs and
 * the only alternative is the hand-written code list this replaces.
 *
 * Only an object `details` can carry it. Spreading an ARRAY — a list of validation issues —
 * turns it into `{"0": …}` and breaks every client that parses it; spreading a STRING turns it
 * into one key per character. Anything that is not a plain object is handed back untouched, and
 * the header still tells that caller when to come back.
 */
function detailsWithRetry(err: AppError): unknown {
  if (err.retryAfterSecs === undefined) return err.details;
  const carries =
    err.details === undefined ||
    (typeof err.details === "object" && err.details !== null && !Array.isArray(err.details));
  if (!carries) return err.details;
  return { ...err.details, retryAfterSecs: err.retryAfterSecs };
}

/**
 * The wire body for an error somebody raised on purpose.
 *
 * It is a function rather than a method on `AppError`, and that is a fix rather than a style
 * choice — see the note on the class. It also keeps the envelope in one file with the mask,
 * instead of in two.
 */
function appErrorBody<Code extends string>(err: AppError<Code>): ApiError<Code> {
  const details = detailsWithRetry(err);
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.messageKey !== undefined && { messageKey: err.messageKey }),
      ...(err.params !== undefined && { params: err.params }),
      ...(details !== undefined && { details }),
    },
  };
}

function envelope<Code extends string, Key extends string>(
  canned: CannedError<Code, Key>,
  details?: unknown,
): ApiError<Code> {
  return {
    error: {
      code: canned.code,
      message: canned.message,
      ...(canned.messageKey !== undefined && { messageKey: canned.messageKey }),
      ...(details !== undefined && { details }),
    },
  };
}

/**
 * What an issue MIGHT carry — every field optional, because the gate below proves only that
 * `issues` is an array and nothing at all about an element. Typing the element as certain is
 * what turned this projection into a throw: `path.map` on an issue that arrived without one.
 */
interface RawIssue {
  readonly path?: unknown;
  readonly code?: unknown;
  readonly maximum?: unknown;
  readonly minimum?: unknown;
}

/** One rejected field: enough to fix the call, and nothing about the schema. */
export interface ValidationIssue {
  /** The field that failed, as the caller spelled it. */
  path: (string | number)[];
  /** The rule that rejected it, such as `too_big`. */
  code: string;
  /** The numeric bound, when the rule has one. */
  maximum?: number;
  minimum?: number;
}

/**
 * Recognize a validation failure without importing the validator.
 *
 * `name === "ZodError"` plus an `issues` array holds for zod 3.25, 4.4 and 4.5 — measured, all
 * three, because this package must not make an adopter's validator its own dependency. It also
 * accepts an issue list that arrived some other way, which is what a second door (an MCP tool,
 * a queue consumer) needs.
 */
function zodIssues(err: unknown): RawIssue[] | null {
  if (typeof err !== "object" || err === null) return null;
  const { name, issues } = err as { name?: unknown; issues?: unknown };
  if (name !== "ZodError" || !Array.isArray(issues)) return null;
  return issues as RawIssue[];
}

/**
 * One path segment, as something that survives `JSON.stringify`.
 *
 * A symbol keyed a field the caller cannot name back at us, so its description is the only
 * useful thing in it — and an unnamed symbol has none, which is an empty segment rather than
 * the `null` that `JSON.stringify` would otherwise write.
 */
function pathSegment(segment: unknown): string | number {
  if (typeof segment === "symbol") return segment.description ?? "";
  return typeof segment === "number" ? segment : String(segment);
}

/**
 * The field path, the rule it failed, and — for a range — the BOUND it failed against.
 *
 * Never the rejected value, and never the schema's internals. All six donors carry a version of
 * that comment; what none of them carries is the proof, so here it is: handing the validator's
 * issues straight to the client ships back the caller's own key names (`keys`), the enum's
 * allowed values (`values`), the validator's English sentence and the expected type
 * (`origin`) — four disclosures from one convenience, and two repos in the fleet do it today.
 * An audit note written against an older validator looks for `received`, which the current one
 * no longer emits; the projection is an allow-list precisely so a rename cannot reopen this.
 *
 * The bound is the exception, and it belongs to the caller: it is the published contract, and
 * a `too_big` without it costs somebody a bisect to rediscover a number our own docs state.
 *
 * Total on purpose: this runs inside the function that turns a thrown thing into an answer, and
 * it is advertised to the queue and tool doors, where an issue list has crossed a serialization
 * hop. An allow-list that throws on a malformed issue sends its caller back to shipping the
 * validator's issues raw, which is the disclosure it exists to prevent.
 */
export function validationIssues(error: {
  readonly issues: readonly RawIssue[];
}): ValidationIssue[] {
  return error.issues.map((issue): ValidationIssue => {
    const { path, code, maximum, minimum } = issue ?? {};
    return {
      path: Array.isArray(path) ? path.map(pathSegment) : [],
      code: typeof code === "string" ? code : "",
      ...(typeof maximum === "number" && { maximum }),
      ...(typeof minimum === "number" && { minimum }),
    };
  });
}

/**
 * `AppError` is generic over the product's own code union, and no runtime check can verify
 * membership. The predicate asserts what `createAppError` guarantees: every `AppError` in this
 * app was built from the map whose keys are `Code`.
 */
function isAppError<Code extends string>(err: unknown): err is AppError<Code> {
  return err instanceof AppError;
}

const DEFAULT_MASKED = ["INTERNAL_ERROR"];

/**
 * Binds the mask policy and the two canned bodies, and returns the function that answers.
 *
 * Bound once, at the app's edge, because the alternative is what the reading found: four places
 * in one fleet deciding the mask separately, and the one furthest from the API getting it
 * wrong. Every other door — a tool wrapper, a worker's health port — imports the same bound
 * function and cannot disagree with the API about what a refusal looks like.
 *
 * ```ts
 * export const errorResponse = createErrorResponse<ErrorCode, MessageKey>({
 *   internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
 *   validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
 * });
 * ```
 */
export function createErrorResponse<Code extends string = string, Key extends string = string>(
  opts: ErrorResponseOptions<Code, Key>,
) {
  const maskedCodes: readonly string[] = opts.maskedCodes ?? DEFAULT_MASKED;

  return function errorResponse(err: unknown): ErrorAnswer<Code> {
    const issues = zodIssues(err);
    if (issues !== null) {
      return {
        status: 400,
        body: envelope(opts.validation, validationIssues({ issues })),
        headers: {},
        kind: "client",
      };
    }

    if (isAppError<Code>(err)) {
      const headers: Record<string, string> = {};
      // The standard header, not just our envelope: every HTTP client, proxy and SDK already
      // knows how to wait on `Retry-After`, and none of them knows `details.retryAfterSecs`.
      // A number only — a refusal that waiting cannot fix says so in the body, because
      // `Retry-After: null` is a header that states a wait and names no time.
      if (typeof err.retryAfterSecs === "number") {
        headers["Retry-After"] = String(err.retryAfterSecs);
      }
      // RFC 6750 §3: a 401 names the scheme it wants. Without it a 401 is a closed door with no
      // handle — which is what an agent, with no human to ask, is left holding.
      if (err.statusCode === 401) headers["WWW-Authenticate"] = "Bearer";

      if (err.statusCode < 500)
        return { status: err.statusCode, body: appErrorBody(err), headers, kind: "client" };

      const hide = !err.expose && (opts.maskAll === true || maskedCodes.includes(err.code));
      if (hide) {
        // The message is replaced; the STATUS is not. A status is chosen by our own map and
        // discloses nothing, while it is the only thing left telling a client whether waiting
        // can help — collapsing a masked 502 into a 500 throws that away for no gain. One
        // donor does collapse it, and never noticed because it masks only the code that is
        // already a 500.
        return { status: err.statusCode, body: envelope(opts.internal), headers, kind: "server" };
      }
      const body = appErrorBody(err);
      if (opts.maskDetails === true) delete body.error.details;
      return { status: err.statusCode, body, headers, kind: "server" };
    }

    // Nothing raised this on purpose, so nothing in it was written for a reader. Whatever it
    // says stays in the log: a background worker in the fleet answers `toMessage(err)` on its
    // health port today, which is a driver's sentence on the wire.
    return { status: 500, body: envelope(opts.internal), headers: {}, kind: "unexpected" };
  };
}
