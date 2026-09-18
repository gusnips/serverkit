/**
 * `@gusnips/server/hono`: the package mounted on a Hono app.
 *
 *     app.use(requestLogger({ logger }));
 *     app.use(errorBoundary);
 *     app.onError(errorHandler({ errorResponse, logger }));
 *     app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))));
 *
 * and, in a test, `assertEveryRouteGuarded(app, { publicPrefixes: ["/health", "/webhooks"] })`.
 */
export { errorBoundary, errorHandler, notFoundHandler } from "./errors.ts";
export type { ErrorHandlerOptions } from "./errors.ts";
export { assertEveryRouteGuarded, guard } from "./guards.ts";
export type { GuardCheckOptions } from "./guards.ts";
export { requestLogger } from "./request-logger.ts";
export type { RequestLoggerOptions, RequestVariables } from "./request-logger.ts";
