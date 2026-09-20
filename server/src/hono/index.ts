/**
 * `@gusnips/server/hono`: the package mounted on a Hono app.
 *
 *     app.use(requestLogger({ logger }));
 *     app.use(errorBoundary);
 *     app.onError(errorHandler({ errorResponse, logger }));
 *     app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))));
 *
 * `ok`, `created`, `paginated` and `noContent` are the success half: they take the `Context` and
 * put the envelope on the wire, so no route has to unwrap the `{ status, body }` answer that the
 * framework-free builders return. Three adopters wrote them by hand and one got that unwrap wrong
 * in production — see `responses.ts` beside this file.
 *
 * and, in a test of the real app, `assertEveryRouteGuarded(app, { isPublic })`, with the rule the
 * app itself uses for what anyone may call.
 */
export { errorBoundary, errorHandler, notFoundHandler } from "./errors.ts";
export type { ErrorHandlerOptions } from "./errors.ts";
export { assertEveryRouteGuarded, guard, underAny } from "./guards.ts";
export type { GuardCheckOptions } from "./guards.ts";
export { created, noContent, ok, paginated } from "./responses.ts";
export { requestLogger } from "./request-logger.ts";
export type { RequestLoggerOptions, RequestVariables } from "./request-logger.ts";
