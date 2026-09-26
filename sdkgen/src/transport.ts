/**
 * The transport under every generated SDK method: one request, one retry rule, one error.
 *
 * This file is a template. `transportSource()` hands it to a generator, which writes it into each
 * SDK as `generated/transport.ts` beside `generated/retry.ts`, so the SDK keeps zero runtime
 * dependencies. It lives here as code rather than as a string so that this package typechecks it
 * and its tests run it. It may import nothing but the retry rule, and only globals that Node, Bun,
 * Deno, a Worker and a browser all have.
 *
 * Whether a failed call is tried again is `@gusnips/http`'s rule, not this file's. What this file
 * decides is what the rule is asked, and the SDKs that wrote their own asked it wrong:
 * - **A write is repeatable only with a key the server reads.** A retried send is a second
 *   message to a real person; with an `Idempotency-Key` the server answers the retry from the
 *   first run instead.
 * - **The rule reads the answer, not the SDK's error.** Three copies decided from their error
 *   class's `retryAfter`, a number or nothing, so the server's explicit
 *   `details.retryAfterSecs: null`, which says waiting never helps, never reached the decision.
 * - **The header is read first, in both its forms.** Two copies read the body's wait before the
 *   `Retry-After` header, and read the header only as seconds, so an HTTP date was no wait at all.
 */
import { parseRetryAfter, retryDelayMs, shouldRetry } from "@gusnips/http/retry";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a generated method tells the transport about its operation. */
export interface RequestSpec {
  method: HttpMethod;
  /** `/numbers/:numberId/pair`. Each `:name` is filled from the params field of that name. */
  path: string;
  /** The operation reads an `Idempotency-Key`, so the server answers a repeat from the first run. */
  keyed?: boolean;
  /** Safe to run twice with no key, such as a read sent as a POST. Absent: true for a GET only. */
  repeatable?: boolean;
}

/** The last argument of every generated method. */
export interface RequestOptions {
  /**
   * Your own key for a call that takes one, such as a UUID saved with the message you send.
   * Every attempt sends the same key, and so can your own retry after a crash.
   */
  idempotencyKey?: string;
  /** How long one attempt waits for an answer, in milliseconds. Overrides the SDK's. */
  timeoutMs?: number;
}

/** The `error` of the envelope, as the answer carried it. */
export interface EnvelopeError {
  /** What went wrong, as a word a program can check. */
  code: string;
  message: string | undefined;
  messageKey: string | undefined;
  params: Record<string, string | number> | undefined;
  /** As sent. `{ retryAfterSecs: null }` means waiting never helps. */
  details: unknown;
}

/** A call that did not work, as `error` gets it to build the SDK's own error. */
export interface Failure {
  method: HttpMethod;
  /** The path with its values filled in: `/numbers/n_1/pair`. */
  path: string;
  /** The HTTP status, or 0 when no answer came back: offline, a dropped connection, a timeout. */
  status: number;
  /** No answer within `timeoutMs`. The call may still have run. */
  timedOut: boolean;
  timeoutMs: number;
  /** The envelope's `error`, when the answer carried one. */
  error: EnvelopeError | undefined;
  /** An answer that was not the envelope, such as a gateway's HTML page: its first 500 characters. */
  text: string | undefined;
  /** `Retry-After` in seconds, whichever of its two forms it came in. */
  retryAfterSecs: number | undefined;
  /** The `x-request-id` header, for the API's support to find the call. */
  requestId: string | undefined;
  /** The key the call was sent with. Retry with it, and a call that ran answers from its first run. */
  idempotencyKey: string | undefined;
  /** What fetch threw, when no answer came back. */
  cause: unknown;
}

/** One SDK's settings. */
export interface Transport {
  /** Where the API lives, with its base path: `https://api.example.com/v1`. */
  baseUrl: string;
  /** Sent on every call, such as the credential and the SDK's version. */
  headers?: Readonly<Record<string, string>>;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** How long one attempt of this call waits for an answer, in milliseconds. Default 30,000. */
  timeoutMs?: (spec: RequestSpec, params: object) => number;
  /** Extra attempts after a failure the retry rule says is worth repeating. Default 2. */
  maxRetries?: number;
  /** Error codes that waiting does not clear, such as a spent monthly quota. */
  durableCodes?: readonly string[];
  /**
   * Make up a key for a call that takes one when the caller sent none, so the call can be retried.
   * Default false: without a key, a write that may have run is not sent again.
   */
  mintKeys?: boolean;
  /** Builds the SDK's own error for a failed call. The transport throws what this returns. */
  error: (failure: Failure) => Error;
}

/** A call that worked. `data` is `undefined` for a 204 or any other empty answer. */
export interface Answer<T, M> {
  data: T;
  meta: M | undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Sends one call, retries it while the rule says so, and returns `{ data, meta }` or throws
 * `transport.error(failure)`. A value the path needs and did not get throws a TypeError before
 * anything is sent.
 */
export async function send<T = unknown, M = unknown>(
  transport: Transport,
  spec: RequestSpec,
  params: object = {},
  opts: RequestOptions = {},
): Promise<Answer<T, M>> {
  // A key the server does not read cannot stop a second run, and treating the call as
  // repeatable because it carries one would send a write twice.
  if (!spec.keyed && opts.idempotencyKey !== undefined) {
    throw new TypeError(
      `${spec.method} ${spec.path} takes no idempotency key, so a key cannot stop it running twice. Leave it out.`,
    );
  }
  // One key per call, not per attempt: a retry has to send the same key to get the first answer.
  const key = spec.keyed
    ? (opts.idempotencyKey ?? (transport.mintKeys ? globalThis.crypto.randomUUID() : undefined))
    : undefined;
  const repeatable = (spec.repeatable ?? spec.method === "GET") || key !== undefined;
  const request = prepare(transport, spec, params, key);
  const timeoutMs = opts.timeoutMs ?? transport.timeoutMs?.(spec, params) ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = transport.maxRetries ?? DEFAULT_MAX_RETRIES;
  // A local, never `transport.fetch(...)`: called as a method, a browser's fetch gets the
  // settings object as `this` and throws "Illegal invocation".
  const fetchImpl = transport.fetch ?? globalThis.fetch;

  for (let attempt = 0; ; attempt++) {
    const outcome = await once<T, M>(fetchImpl, request, timeoutMs);
    if (outcome.ok) return outcome.answer;
    const failure: Failure = { ...outcome.failure, idempotencyKey: key };
    // The rule reads these fields as the answer sent them: the header's wait apart from the
    // body's, and `details` untouched, so an explicit `retryAfterSecs: null` still says never.
    const answer = {
      status: failure.status,
      code: failure.error?.code,
      details: failure.error?.details,
      retryAfterSecs: failure.retryAfterSecs,
    };
    const again =
      attempt < maxRetries &&
      shouldRetry(answer, { repeatable, durableCodes: transport.durableCodes });
    if (!again) throw transport.error(failure);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(attempt, answer)));
  }
}

interface Prepared {
  method: HttpMethod;
  path: string;
  url: string;
  headers: Headers;
  body: string | undefined;
}

type Outcome<T, M> =
  { ok: true; answer: Answer<T, M> } | { ok: false; failure: Omit<Failure, "idempotencyKey"> };

/** The request every attempt sends: the path filled in, the rest in the query or the body. */
function prepare(
  transport: Transport,
  spec: RequestSpec,
  params: object,
  key: string | undefined,
): Prepared {
  const values = new Map<string, unknown>(Object.entries(params));
  const path = spec.path.replace(/:(\w+)/g, (_slot, name: string) => {
    const value = values.get(name);
    // An empty segment would send the call to a different route: `/numbers//pair`.
    if ((typeof value !== "string" && typeof value !== "number") || value === "") {
      throw new TypeError(`${spec.method} ${spec.path} needs \`${name}\` for its path.`);
    }
    return encodeURIComponent(String(value));
  });
  for (const name of spec.path.match(/:\w+/g) ?? []) values.delete(name.slice(1));

  const url = new URL(transport.baseUrl.replace(/\/+$/, "") + path);
  const inQuery = spec.method === "GET" || spec.method === "DELETE";
  if (inQuery) {
    for (const [name, value] of values) {
      // An array is the name repeated, `?tag=a&tag=b`, which is how a query string carries a list.
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === undefined || item === null) continue;
        if (typeof item === "object") {
          throw new TypeError(
            `${spec.method} ${spec.path}: \`${name}\` cannot go in a query string.`,
          );
        }
        url.searchParams.append(name, String(item));
      }
    }
  }

  const headers = new Headers(transport.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (!inQuery) headers.set("content-type", "application/json");
  if (key !== undefined) headers.set("idempotency-key", key);
  return {
    method: spec.method,
    path,
    url: url.toString(),
    headers,
    // Every write sends a body, `{}` included: a handler that parses JSON answers 400 to none.
    body: inQuery ? undefined : JSON.stringify(Object.fromEntries(values)),
  };
}

/** One attempt. Never throws: a failure is a value, so the loop can ask the rule about it. */
async function once<T, M>(
  fetchImpl: typeof fetch,
  request: Prepared,
  timeoutMs: number,
): Promise<Outcome<T, M>> {
  const base = { method: request.method, path: request.path, timeoutMs };
  let response: Response;
  let text: string;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Inside the try: a connection that drops halfway through the body is no answer either.
    text = await response.text();
  } catch (cause) {
    return {
      ok: false,
      failure: {
        ...base,
        status: 0,
        timedOut: isTimeout(cause),
        error: undefined,
        text: undefined,
        retryAfterSecs: undefined,
        requestId: undefined,
        cause,
      },
    };
  }

  const body = parse(text);
  if (response.ok && body !== undefined) {
    // The one place the SDK takes the API's word for a type: the contract says what `data` is.
    return { ok: true, answer: { data: body["data"] as T, meta: body["meta"] as M | undefined } };
  }
  const error = envelopeError(body?.["error"]);
  return {
    ok: false,
    failure: {
      ...base,
      // A 2xx lands here only when its body is not JSON, which is not the API answering.
      status: response.status,
      timedOut: false,
      error,
      text: error === undefined && text !== "" ? text.slice(0, 500) : undefined,
      retryAfterSecs: parseRetryAfter(response.headers.get("retry-after")),
      requestId: response.headers.get("x-request-id") ?? undefined,
      cause: undefined,
    },
  };
}

/** The body as a JSON object: `{}` when empty, `undefined` when it is not a JSON object. */
function parse(text: string): Record<string, unknown> | undefined {
  if (text === "") return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function envelopeError(value: unknown): EnvelopeError | undefined {
  if (!isRecord(value)) return undefined;
  const { code, message, messageKey, params, details } = value;
  if (typeof code !== "string") return undefined;
  return {
    code,
    message: typeof message === "string" ? message : undefined,
    messageKey: typeof messageKey === "string" ? messageKey : undefined,
    params: isParams(params) ? params : undefined,
    details,
  };
}

function isParams(value: unknown): value is Record<string, string | number> {
  return (
    isRecord(value) &&
    Object.values(value).every((v) => typeof v === "string" || typeof v === "number")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `AbortSignal.timeout` rejects with a DOMException named TimeoutError. */
function isTimeout(cause: unknown): boolean {
  return (
    typeof cause === "object" && cause !== null && "name" in cause && cause.name === "TimeoutError"
  );
}
