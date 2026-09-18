import type { Hono, MiddlewareHandler } from "hono";
import { METHODS } from "hono/router";
import type { RouterRoute } from "hono/types";
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
  /**
   * The app's own rule for what anyone may call, asked with the path a request would carry:
   * `/people/:id` is asked as `/people/probe`, `/reports/:id{[0-9]+}` as `/reports/1`. Pass the
   * predicate or the list the app itself uses, never a second one kept for the test: an exemption
   * list nothing else reads is the next thing to drift. `underAny(list)` reads a list as prefixes.
   */
  isPublic: (path: string) => boolean;
}

/**
 * "Under one of these", reading each entry as a prefix whichever pattern form it holds:
 * `/feedback` and `/feedback/*` both cover `/feedback` and `/feedback/mine`, and neither covers
 * `/feedbacks`. Hono reads `use("/feedback")` as that one path, which is how the route under it
 * once shipped public while the list said it was guarded.
 */
export function underAny(prefixes: readonly string[]): (path: string) => boolean {
  const bases = prefixes.map((prefix) => prefix.replace(/\/\*$/, ""));
  return (path) => bases.some((base) => path === base || path.startsWith(`${base}/`));
}

const isGuard = (handler: RouterRoute["handler"]) => GUARD in findTargetHandler(handler);

/**
 * Throws, naming every endpoint no guard runs in front of, and every guard that runs in front of
 * nothing. Build the real app, and call it in a test once every route is registered: the first
 * match freezes Hono's router.
 *
 * It asks Hono's own router what would run for each of the app's real routes, and in what order,
 * rather than comparing patterns. A pattern list cannot see order, and order is the whole bug: a
 * `use()` registered after its route matches that route and never runs for it, because the
 * handler answers first. Only the matcher tells a guard that never fires from one that does.
 *
 * A guard in front of nothing is the trace a router leaves when it mounted no routes, which is
 * what a stand-in dependency's router does in a test: its routes drop out of the check, and the
 * check would pass by having nothing to ask. A guard inside that router drops out with it, so a
 * stand-in that yields a router should throw when Hono reads its `routes`.
 *
 * An endpoint is what Hono's own route inspector calls one, a handler taking fewer than two
 * arguments. So a `(c, next)` handler that answers is not checked, and a path whose parameter
 * pattern rejects the probe is reported as unprobeable rather than passed.
 */
export function assertEveryRouteGuarded(
  app: Pick<Hono, "routes" | "router">,
  { isPublic }: GuardCheckOptions,
): void {
  const endpoints = app.routes.filter((route) => !isMiddleware(findTargetHandler(route.handler)));
  if (endpoints.length === 0)
    throw new Error(
      "The app has no endpoints to check, so the check would pass by asking nothing.",
    );
  const idle = new Set(app.routes.filter((route) => isGuard(route.handler)));
  const unguarded = new Set<string>();
  for (const route of endpoints) {
    const { method, path } = route;
    const probe = path.replace(/:\w+\{[^}]*\}\??/g, "1").replace(/:\w+\??|\*/g, "probe");
    const open = isPublic(probe);
    for (const each of method === "ALL" ? METHODS.map((m) => m.toUpperCase()) : [method]) {
      const [matched] = app.router.match(each, probe);
      const at = matched.findIndex(([[, candidate]]) => candidate === route);
      const ahead = matched.slice(0, Math.max(at, 0)).filter(([[handler]]) => isGuard(handler));
      for (const [[, guardRoute]] of ahead) idle.delete(guardRoute);
      if (open) continue;
      if (at === -1) unguarded.add(`${method} ${path} (could not be probed at ${probe})`);
      else if (ahead.length === 0) unguarded.add(`${method} ${path}`);
    }
  }
  if (unguarded.size === 0 && idle.size === 0) return;
  const list = (lines: Iterable<string>) =>
    [...new Set(lines)]
      .sort()
      .map((line) => `  ${line}\n`)
      .join("");
  const idleLines = [...idle].map((route) => `${route.method} ${route.path}`);
  throw new Error(
    (unguarded.size > 0
      ? `${String(unguarded.size)} endpoint(s) answer with no guard running in front of them:\n` +
        list(unguarded)
      : "") +
      (idle.size > 0
        ? `${String(new Set(idleLines).size)} guard(s) run in front of no endpoint:\n` +
          list(idleLines)
        : "") +
      "A guard counts when it is wrapped in guard() and registered BEFORE its routes: a use() " +
      "added after them never runs for them. A guard in front of nothing sits after its routes, " +
      "or over a router that mounted none. Move it up, build that router for real, or have " +
      "isPublic say so if anyone may call the path.",
  );
}
