import type { Hono, MiddlewareHandler } from "hono";
import { METHODS } from "hono/router";
import { findTargetHandler, isMiddleware } from "hono/utils/handler";

const GUARD = Symbol.for("@gusnips/server/hono:guard");

/**
 * Marks a middleware as one that decides who may pass, for `assertEveryRouteGuarded`. Returns the
 * same function. Mark it where it is defined, so every place it is mounted counts.
 *
 *     export const requireAdmin = guard(async (c, next) => { … });
 */
export function guard<H extends MiddlewareHandler>(middleware: H): H {
  Object.defineProperty(middleware, GUARD, { value: true });
  return middleware;
}

export interface GuardCheckOptions {
  /** Paths anyone may call, each with everything under it: `/webhooks` covers `/webhooks/pay`. */
  publicPrefixes: readonly string[];
}

/**
 * Throws, naming every endpoint no guard runs in front of. Call it in a test, once every route is
 * registered: the first match freezes Hono's router.
 *
 * It asks Hono's own router what would run for each endpoint, and in what order, rather than
 * comparing patterns. A pattern list cannot see order, and order is the whole bug: a `use()`
 * registered after its route matches that route and never runs for it, because the handler
 * answers first. Only the matcher tells a guard that never fires from one that does.
 *
 * An endpoint is what Hono's own route inspector calls one, a handler taking fewer than two
 * arguments. So a `(c, next)` handler that answers is not checked, and a path whose parameter
 * pattern rejects the word "probe" is reported as unprobeable rather than passed.
 */
export function assertEveryRouteGuarded(
  app: Pick<Hono, "routes" | "router">,
  { publicPrefixes }: GuardCheckOptions,
): void {
  const unguarded = new Set<string>();
  for (const route of app.routes) {
    const { method, path } = route;
    if (isMiddleware(findTargetHandler(route.handler))) continue;
    if (publicPrefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
    const probe = path.replace(/:[^/]+|\*/g, "probe");
    for (const each of method === "ALL" ? METHODS.map((m) => m.toUpperCase()) : [method]) {
      const [matched] = app.router.match(each, probe);
      const at = matched.findIndex(([[, candidate]]) => candidate === route);
      if (at === -1) unguarded.add(`${method} ${path} (could not be probed at ${probe})`);
      else if (!matched.slice(0, at).some(([[handler]]) => GUARD in findTargetHandler(handler)))
        unguarded.add(`${method} ${path}`);
    }
  }
  if (unguarded.size === 0) return;
  throw new Error(
    `${String(unguarded.size)} endpoint(s) answer with no guard running in front of them:\n` +
      [...unguarded]
        .sort()
        .map((line) => `  ${line}\n`)
        .join("") +
      "A guard counts when it is wrapped in guard() and registered BEFORE the route: a use() " +
      "added after its route never runs for it. Move it up, or list the path in publicPrefixes " +
      "if anyone may call it.",
  );
}
