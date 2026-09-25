import type { Context, MiddlewareHandler } from "hono";
import { clientIpOf, type PlatformIpHeader } from "../client-ip.ts";

export interface ClientIpVariables {
  /** The client's address, or `null` when none can be trusted. See `clientIpOf`. */
  clientIp: string | null;
}

type ClientIpEnv = { Variables: ClientIpVariables };

export type ClientIpOptions =
  /**
   * On a box: the socket peer. Under Bun, pass `bunPeer`; on another runtime, its `getConnInfo`.
   * It is an argument because each runtime has its own, and importing one would break the others.
   */
  | { peerOf: (c: Context) => string | undefined }
  /** On a Worker or on Fly, where the edge sets this header on every request. */
  | { header: PlatformIpHeader };

/**
 * Sets `c.var.clientIp` once, for every limiter and log line after it.
 *
 *     app.use(clientIp({ peerOf: bunPeer }));
 *
 * A `peerOf` that throws reads as no peer, so `clientIp` is `null`. `hono/bun`'s `getConnInfo`
 * throws on every request that did not come through `Bun.serve`, which is every `app.request()`
 * in a test; without this an app's own tests could not run through it.
 */
export function clientIp<E extends ClientIpEnv = ClientIpEnv>(
  options: ClientIpOptions,
): MiddlewareHandler<E> {
  return async (c, next) => {
    c.set("clientIp", clientIpOf(c.req.raw.headers, sourceOf(options, c)));
    await next();
  };
}

/**
 * The socket peer under `Bun.serve`, for `clientIp({ peerOf: bunPeer })`, and `undefined` when
 * there is none: an `app.request()` in a test, or another runtime.
 *
 * It reads what `hono/bun`'s `getConnInfo` reads, the server Bun hands `fetch` as its second
 * argument, which Hono keeps as `c.env`. It exists because importing `hono/bun` reads the `Bun`
 * global at load, so an app module that imports it cannot even load in a test run under Node.
 * Five adopters of the recipe this replaced found that out one at a time.
 */
export function bunPeer(c: Context): string | undefined {
  const env: unknown = c.env;
  // Hono's own reader accepts both shapes: the server itself, or `{ server }` beside bindings.
  const server: unknown =
    typeof env === "object" && env !== null && "server" in env ? env.server : env;
  if (typeof server !== "object" || server === null || !("requestIP" in server)) return undefined;
  if (typeof server.requestIP !== "function") return undefined;
  const info: unknown = server.requestIP(c.req.raw);
  return typeof info === "object" &&
    info !== null &&
    "address" in info &&
    typeof info.address === "string"
    ? info.address
    : undefined;
}

function sourceOf(options: ClientIpOptions, c: Context) {
  if ("header" in options) return options;
  try {
    return { peer: options.peerOf(c) };
  } catch {
    return { peer: undefined };
  }
}
