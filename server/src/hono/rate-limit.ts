import type { Context, Env, MiddlewareHandler } from "hono";
import type { Logger } from "../logger/index.ts";
import {
  countWindow,
  type MemoryWindowStore,
  type RefusedHit,
  type WindowStore,
} from "../rate-limit.ts";

interface RateLimitCommon<E extends Env> {
  /**
   * Names the limiter: the start of every key it counts, and the second argument to `refuse`.
   * Two limiters sharing a store need different scopes, or they count each other's requests.
   */
  scope: string;
  /** A number, or one read off the request, for a limit that comes from the caller's plan. */
  limit: number | ((c: Context<E>) => number);
  windowMs: number;
  /**
   * Who is being counted, or `null` to let the request through uncounted.
   *
   * **It must be a value the server has checked.** A limiter mounted before auth that keys on
   * the bearer token counts whatever string the caller sends, so a fresh random token each time
   * is a fresh allowance each time: measured on one backend, 300 requests from one address with
   * a new token each were refused 0 times. Key on an address before auth, and on the verified
   * user, key or account after it.
   */
  key: (c: Context<E>) => string | null;
  /** The product's own 429, from its `errors` table. `hit.retryAfterSecs` is its wait. */
  refuse: (hit: RefusedHit, scope: string) => Error;
}

export type RateLimitOptions<E extends Env = Env> = RateLimitCommon<E> &
  (
    | { store: MemoryWindowStore; whenStoreFails?: never; logger?: never }
    | {
        store: WindowStore;
        /**
         * `"allow"`, or the product's 503 to refuse with. There is no default: a limit that
         * guards a promise allows, one that guards a bill refuses (see `hitWindow`).
         */
        whenStoreFails: "allow" | ((error: unknown, scope: string) => Error);
        /** Where a store failure is written, allowed or refused. An allowed one is otherwise
         *  silent, and a limiter that has quietly stopped limiting is the failure to catch. */
        logger: Logger;
      }
  );

/**
 * A fixed-window limit in front of the routes it is mounted on. It throws the product's own
 * error, so the refusal goes through the app's `onError` like any other, and a `retryAfterSecs`
 * on it becomes `Retry-After`.
 *
 *     app.use("/v1/*", rateLimit<AppEnv>({
 *       scope: "api",
 *       store: redisWindowStore(limitsRedis, { timeoutMs: 500 }),
 *       whenStoreFails: "allow",
 *       logger,
 *       limit: (c) => planOf(c.get("user")).requestsPerMinute,
 *       windowMs: 60_000,
 *       key: (c) => c.get("user").accountId,
 *       refuse: (hit) => errors.rateLimit(hit.retryAfterSecs),
 *     }));
 */
export function rateLimit<E extends Env = Env>(options: RateLimitOptions<E>): MiddlewareHandler<E> {
  const { scope, limit, windowMs, key, refuse, store, whenStoreFails, logger } = options;
  const policy =
    whenStoreFails === undefined ? undefined : whenStoreFails === "allow" ? "allow" : "refuse";
  return async (c, next) => {
    const subject = key(c);
    if (subject !== null) {
      const ceiling = typeof limit === "number" ? limit : limit(c);
      const hit = await countWindow(store, `${scope}:${subject}`, {
        limit: ceiling,
        windowMs,
        whenStoreFails: policy,
      });
      if (hit.outcome === "store-failed") {
        // The scope and never the subject: a subject is an address or an account.
        logger?.warn("[rate-limit] the store did not answer", {
          scope,
          allowed: hit.allowed,
          error: hit.error,
        });
        if (typeof whenStoreFails === "function") throw whenStoreFails(hit.error, scope);
      } else if (!hit.allowed) throw refuse(hit, scope);
    }
    await next();
  };
}
