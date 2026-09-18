/**
 * `@gusnips/server/hono`: the package mounted on a Hono app.
 *
 *     app.use(requestLogger({ logger }));
 *     app.use(errorBoundary);
 *     app.onError(errorHandler({ errorResponse, logger }));
 *     app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))));
 */
export { errorBoundary, errorHandler, notFoundHandler } from "./errors.ts";
export type { ErrorHandlerOptions } from "./errors.ts";
export { requestLogger } from "./request-logger.ts";
export type { RequestLoggerOptions, RequestVariables } from "./request-logger.ts";
