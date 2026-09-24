import type { Context, ErrorHandler, MiddlewareHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { toMessage } from "../errors.ts";
import type { Logger } from "../logger/index.ts";
import type { ErrorAnswer } from "../responses.ts";
import type { RequestVariables } from "./request-logger.ts";

/**
 * The app's own env, taken from the `onError` / `notFound` call it is passed to, so its bindings
 * and variables fit as they are. The code type comes from its `errorCode`, which is what stops
 * `errorResponse` from answering a code that slot cannot hold.
 */
type ErrorEnv = { Variables: RequestVariables };
type CodeOf<E extends ErrorEnv> = NonNullable<E["Variables"]["errorCode"]>;

/**
 * Turns a thrown non-`Error` into an `Error`, so it reaches `onError`.
 *
 * Hono hands `onError` only what is `instanceof Error`. Anything else is rethrown past every
 * layer and escapes as an unhandled rejection: no answer, a dropped connection, and a browser that
 * reports it as a CORS failure — which sends whoever reads it to the wrong layer. A PostgREST
 * client rejects with plain objects, so this is not hypothetical. The original rides as `cause`.
 *
 * Mount it after `requestLogger`, `apiSecureHeaders` and `corsAllowList`. A middleware inside the
 * boundary that writes headers once the route has answered, as `secureHeaders` does, never gets to
 * write them for a throw that is not an `Error`.
 */
export const errorBoundary: MiddlewareHandler = async (_c, next) => {
  try {
    await next();
  } catch (err) {
    if (err instanceof Error) throw err;
    throw new Error(toMessage(err), { cause: err });
  }
};

export interface ErrorHandlerOptions<E extends ErrorEnv> {
  /** Your bound `createErrorResponse(...)`. */
  errorResponse: (err: unknown) => ErrorAnswer<CodeOf<E>>;
  logger: Logger;
  /**
   * Called for a throw nobody raised on purpose, which is where an alert belongs. It runs inside
   * `onError`, so it must not throw, and anything slow should be sent without being awaited.
   */
  onUnexpected?: (err: unknown, c: Context<E>) => void;
}

/**
 * `app.onError(errorHandler({ errorResponse, logger }))`.
 *
 * A refusal under 500 writes no line of its own: its code rides on the request line, because one
 * line per wrong password buries the failures that need a human. A 5xx and an escaped throw are
 * logged with the raw error, stack and cause included.
 */
export function errorHandler<E extends ErrorEnv>({
  errorResponse,
  logger,
  onUnexpected,
}: ErrorHandlerOptions<E>): ErrorHandler<E> {
  return (err, c) => {
    const answer = errorResponse(err);
    if (answer.kind !== "client")
      logger.error("request failed", {
        requestId: c.get("requestId"),
        kind: answer.kind,
        error: err,
      });
    if (answer.kind === "unexpected") onUnexpected?.(err, c);
    return respond(c, answer);
  };
}

/** `app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))))`. */
export const notFoundHandler =
  <E extends ErrorEnv>(answer: ErrorAnswer<CodeOf<E>>): NotFoundHandler<E> =>
  (c) =>
    respond(c, answer);

function respond<E extends ErrorEnv>(c: Context<E>, answer: ErrorAnswer<CodeOf<E>>) {
  // An error answered as a 2xx reads as success to every client. Thrown instead, it comes back
  // through onError as the unexpected throw it is: the generic 500, logged, and alerted on.
  if (!isErrorStatus(answer.status)) throw new RangeError(`An error answered ${answer.status}.`);
  c.set("errorCode", answer.body.error.code);
  return c.json(answer.body, answer.status, answer.headers);
}

const isErrorStatus = (status: number): status is ContentfulStatusCode =>
  status >= 400 && status <= 599;
