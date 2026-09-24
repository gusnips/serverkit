import type { Context, MiddlewareHandler } from "hono";
import { clientIpOf, type PlatformIpHeader } from "../client-ip.ts";

export interface ClientIpVariables {
  /** The client's address, or `null` when none can be trusted. See `clientIpOf`. */
  clientIp: string | null;
}

type ClientIpEnv = { Variables: ClientIpVariables };

export type ClientIpOptions =
  /**
   * On a box: the socket peer, from your runtime's `getConnInfo`. It is an argument because each
   * runtime has its own (`hono/bun`, `hono/deno`), and importing one would break the others.
   */
  | { peerOf: (c: Context) => string | undefined }
  /** On a Worker or on Fly, where the edge sets this header on every request. */
  | { header: PlatformIpHeader };

/**
 * Sets `c.var.clientIp` once, for every limiter and log line after it.
 *
 *     import { getConnInfo } from "hono/bun";
 *     app.use(clientIp({ peerOf: (c) => getConnInfo(c).remote.address }));
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

function sourceOf(options: ClientIpOptions, c: Context) {
  if ("header" in options) return options;
  try {
    return { peer: options.peerOf(c) };
  } catch {
    return { peer: undefined };
  }
}
