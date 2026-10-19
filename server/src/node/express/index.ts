/**
 * The kit's Hono doors (`restRoutes`, `mcpRoutes`) inside an Express app, so an Express backend
 * serves its API and its MCP door with the same code a Hono backend runs.
 *
 * `@hono/node-server` does the translation. What this adds are the two ways the plain recipe
 * breaks without a word, both measured on Express 4.22 under Bun 1.4.2 and Node 24.21:
 * - **Express strips the mount path.** Under `app.use("/v1", …)` the request's URL is `/things`,
 *   so a Hono app whose routes say `/v1/things` answered 404 on every one. The full URL goes back
 *   before Hono sees it.
 * - **A body parser mounted first empties the body.** After `express.json()` the stream is spent:
 *   a POST reached Hono as `{}`, so a write whose fields all have defaults would run on nothing, an
 *   MCP call failed as a parse error, and a malformed body answered Express's HTML page with the
 *   stack in it. A request a parser already read is refused here, so the wrong order fails on the
 *   first request instead of quietly.
 *
 * `@gusnips/server/express`. `@hono/node-server` is an optional peer, and this subpath is the only
 * place that imports it. No Express import: the types below are the parts of its request it reads.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { getRequestListener, type Http2Bindings, type HttpBindings } from "@hono/node-server";

/** The parts of Express's request this reads. Express's own `Request` fits it. */
export type ExpressRequest = IncomingMessage & { originalUrl: string; body?: unknown };

/**
 * One Express middleware that hands the request to a Hono app. Mount it before any body parser,
 * on the paths the Hono app's routes start with:
 *
 *     app.use(["/v1", "/mcp"], fromHono(api)); // api: a Hono app with routes under /v1 and /mcp
 *     app.use(express.json());
 */
export function fromHono(app: {
  fetch: (request: Request, env: HttpBindings | Http2Bindings) => Response | Promise<Response>;
}): (req: ExpressRequest, res: ServerResponse, next: (error?: unknown) => void) => void {
  const listener = getRequestListener((request, env) => app.fetch(request, env));
  return (req, res, next) => {
    if (req.body !== undefined) {
      next(
        new Error(
          `A body parser read ${req.originalUrl} before fromHono could, so the API would see an ` +
            "empty body. Mount fromHono before express.json() and express.urlencoded().",
        ),
      );
      return;
    }
    req.url = req.originalUrl;
    listener(req, res).catch(next);
  };
}
