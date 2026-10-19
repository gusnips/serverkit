/**
 * The REST door for a list of operations: each one mounted at its method and path, its input read
 * one way on every route, and its answer put in the envelope. The MCP door is `mcpRoutes`; both
 * call the same operations, and only the transport differs.
 *
 * Three backends wrote this loop, and each knew something the others did not:
 * - **A repeated query parameter is a list.** `c.req.query()` keeps only the first value. Two of
 *   them read the query that way. The third keeps every value, because its filters take several:
 *   `?status=failed&status=cancelled`.
 * - **A body that is not a JSON object is refused, never read as `{}`.** Two of them read a body
 *   that failed to parse as `{}`, so the schema would answer, and a write whose fields all have
 *   defaults would run on a body nobody could read. An empty body is still `{}`.
 * - **The path's ids and the rest of the input arrive apart.** Two merged them with the path
 *   winning and one kept them apart, so a caller who names one id in the path and another in the
 *   query is never misread by the transport. Merging is one line in `run`.
 * - **What needs only the headers runs first.** `before` (the key check, a rate limit) runs ahead
 *   of the body limit, which reads a chunked body whole, so a stranger is refused before a
 *   megabyte arrives.
 *
 * Nothing here validates. The input reaches `run` as it was read, so the product decides who may
 * call before any schema says what is wrong with the input, and before a stored answer is replayed.
 */
import { Hono, type Context, type Env, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpMethod } from "../openapi/index.ts";
import { noContent, ok } from "./responses.ts";

/** What a route hands `run`. */
export interface RestRequest {
  /** The path's slots: `{ id: "42" }` for `/things/:id`. */
  params: Record<string, string>;
  /**
   * The query string on a GET or a DELETE, with a repeated name as a list of its values. The JSON
   * body on any other method, `{}` when there is none. The same rule `buildOpenApi` documents.
   */
  input: Record<string, unknown>;
}

/** What `run` hands back: the envelope's `data`, and its `meta` when there is one. */
export interface RestAnswer {
  data: unknown;
  /** What the call cost, a page's counts: whatever your API puts beside `data`. */
  meta?: unknown;
}

export interface RestRoute<E extends Env = Env> {
  method: HttpMethod;
  /** As Hono spells it, the same string `buildOpenApi` takes: `/things/:id`. */
  path: `/${string}`;
  /**
   * 200 by default. 201 when the call made something with its own address, 202 when it accepted
   * work still running, 204 for no body at all: `data` is then dropped, so an operation can still
   * hand its MCP tool a result.
   */
  status?: 200 | 201 | 202 | 204;
  /** This route's largest body in bytes, when it differs from the list's. */
  bodyLimit?: number;
  /** Middleware for this route alone, run before the body is read: the key check, a rate limit. */
  before?: readonly MiddlewareHandler<E>[];
  /** Your operation. Throw your own errors: they reach `onError` with any header already set. */
  run: (c: Context<E>, request: RestRequest) => Promise<RestAnswer>;
}

export interface RestRoutesOptions {
  /**
   * The largest body any route reads, in bytes, unless the route names its own. Required, because
   * the runtime's default is the only other answer: Bun's is 128 MiB.
   */
  bodyLimit: number;
  /** Your 413, from your errors table. */
  tooLarge: (maxBytes: number) => Error;
  /**
   * Your 400 for a body that is not a JSON object: `"malformed"` when it is not JSON, and
   * `"not-an-object"` when it is a string, a number, an array or `null`.
   */
  invalidBody: (reason: "malformed" | "not-an-object") => Error;
}

/**
 * A router with one route per entry. Mount it where the paths start:
 *
 *     app.route("/v1", restRoutes(
 *       OPERATIONS.map((op) => ({
 *         method: op.method,
 *         path: op.path,
 *         status: op.status,
 *         before: op.keyless ? [] : [requireApiKey],
 *         run: async (c, { params, input }) => ({
 *           data: await op.run(callerOf(c), { ...input, ...params }),
 *         }),
 *       })),
 *       { bodyLimit: 1024 * 1024, tooLarge: errors.payloadTooLarge, invalidBody: errors.badJson },
 *     ));
 */
export function restRoutes<E extends Env = Env>(
  routes: readonly RestRoute<E>[],
  options: RestRoutesOptions,
): Hono<E> {
  const router = new Hono<E>();
  const mounted = new Set<string>();
  for (const route of routes) {
    const { method, path } = route;
    // Hono would mount both and answer with the first, so the second operation would never run.
    const id = `${method.toUpperCase()} ${path}`;
    if (mounted.has(id))
      throw new Error(`${id} is in the list twice. Give each operation its own method and path.`);
    mounted.add(id);

    for (const middleware of route.before ?? []) router.on(method, path, middleware);
    const readsBody = method !== "get" && method !== "delete";
    if (readsBody) {
      const maxSize = route.bodyLimit ?? options.bodyLimit;
      router.on(
        method,
        path,
        bodyLimit({
          maxSize,
          onError: () => {
            throw options.tooLarge(maxSize);
          },
        }),
      );
    }
    router.on(method, path, async (c) => {
      const input = readsBody ? await bodyInput(c, options.invalidBody) : queryInput(c);
      const { data, meta } = await route.run(c, { params: c.req.param(), input });
      return route.status === 204 ? noContent(c) : ok(c, data, route.status ?? 200, meta);
    });
  }
  return router;
}

function queryInput(c: Context): Record<string, string | string[]> {
  return Object.fromEntries(
    Object.entries(c.req.queries()).map(([name, values]) => [
      name,
      values.length === 1 ? (values[0] ?? "") : values,
    ]),
  );
}

async function bodyInput(
  c: Context,
  invalidBody: RestRoutesOptions["invalidBody"],
): Promise<Record<string, unknown>> {
  const text = (await c.req.text()).trim();
  if (!text) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalidBody("malformed");
  }
  if (!isJsonObject(body)) throw invalidBody("not-an-object");
  return body;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
