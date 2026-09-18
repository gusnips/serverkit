/**
 * `@gusnips/server/hono`: the package mounted on a Hono app.
 *
 *     app.use(requestLogger({ logger }));
 */
export { requestLogger } from "./request-logger.ts";
export type { RequestLoggerOptions, RequestVariables } from "./request-logger.ts";
