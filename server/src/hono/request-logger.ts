import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { Logger } from "../logger/index.ts";

/** The two variables this adapter writes. Put them in your app's `Variables`. */
export interface RequestVariables<Code extends string = string> {
  requestId: string;
  /** The code of the refusal this request got, for the request line. `null` until one happens. */
  errorCode: Code | null;
}

export interface RequestLoggerOptions {
  logger: Logger;
  /**
   * Paths answered but never logged, each with everything under it: `/health` covers
   * `/health/db` and not `/healthz`. Defaults to `["/health"]`. A throw is logged anyway.
   */
  skipPaths?: readonly string[];
}

/**
 * A caller's id is echoed back and written into every line, so it is kept only in a shape that
 * cannot carry anything else: 64 characters of `A-Z a-z 0-9 . _ -`. Anything else is replaced, not
 * trimmed, so the id in the log is always either the caller's or ours.
 */
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * One line per request, and the request id.
 *
 * Mount it first, so it times and sees everything under it:
 *
 *     app.use(requestLogger({ logger }));
 *
 * The id goes back on `X-Request-ID`, which is where the browser client reads it from, on every
 * answer including `onError`'s and `notFound`'s. Cross-origin, list that header in your CORS
 * `exposeHeaders` or the browser hides it from the page.
 */
export function requestLogger({
  logger,
  skipPaths = ["/health"],
}: RequestLoggerOptions): MiddlewareHandler<{ Variables: RequestVariables }> {
  return async (c, next) => {
    const supplied = c.req.header("X-Request-ID");
    const requestId = supplied && REQUEST_ID.test(supplied) ? supplied : crypto.randomUUID();
    c.set("requestId", requestId);
    c.set("errorCode", null);
    const { method, path } = c.req;
    const start = Date.now();
    // The route TEMPLATE, never the path: a path carries whatever the caller put in it, and in one
    // backend that was a national id number, which the request line carried into an analytics
    // event. The last matched route rather than the deepest one that ran, so a 401 from an auth
    // middleware is filed under the endpoint it protected.
    const line = (status: number) => ({
      requestId,
      method,
      route: routePath(c, -1),
      status,
      ms: Date.now() - start,
      errorCode: c.get("errorCode") ?? undefined,
    });
    try {
      await next();
    } catch (err) {
      // Only what Hono would not hand to onError gets here: a non-`Error` with no `errorBoundary`
      // above it, or a throw from onError itself. Nothing answered it, so the runtime will, and
      // the request that most needs a line is the one that would otherwise never get one.
      logger.error("request", { ...line(500), error: err });
      throw err;
    }
    // After `next()`, not before: a header set earlier lives on a draft Hono drops when a handler
    // returns a Response it built itself.
    c.header("X-Request-ID", requestId);
    const skipped = skipPaths.some((skip) => path === skip || path.startsWith(`${skip}/`));
    if (method !== "OPTIONS" && !skipped) logger.info("request", line(c.res.status));
  };
}
