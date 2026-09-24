/**
 * A fixed-window rate limit: the arithmetic, the store contract, and a store in this process's
 * memory. The Redis store is in `/redis` and the Hono middleware in `/hono`.
 *
 * Nine backends wrote this, and each design knew one of four things the others did not. Most
 * refuse a new key once the map is full, and one had the cap without the refusal that makes it
 * hold. Two decided per limiter what a Redis outage means, and wrote down why. The Redis copies
 * count and re-arm the expiry in one round trip, where the one written separately makes two
 * calls and can leave a key that never expires. One took the limit from the caller's plan. This
 * file holds all four, and the two choices that are the product's stay arguments: what a limit
 * counts, and what the refusal says.
 *
 * Windows line up with the clock (`floor(now / windowMs)`), as all three Redis copies do, so a
 * memory store and a Redis store count the same window and `retryAfterSecs` is the real end of
 * it. A constant wait overstates it by up to a whole window.
 */

/** What a limiter does with a request when its store does not answer. */
export type StoreFailurePolicy = "allow" | "refuse";

export interface WindowStore {
  /**
   * Whether {@link WindowStore.hit} can reject. A store in this process cannot. A store across
   * the network can, and a limiter using one must say what an outage means, which is why the
   * types ask for `whenStoreFails` exactly when this is not `false`.
   */
  readonly canFail: boolean;
  /**
   * Count one request in the window `key` names and answer the count, this request included.
   * The window closes at `resetAt` (ms since the epoch), and the store may forget it after that.
   * `"full"` means the store refused to start tracking a new window.
   */
  hit(key: string, resetAt: number, now: number): Promise<number | "full">;
}

export interface MemoryWindowStore extends WindowStore {
  readonly canFail: false;
}

export interface MemoryWindowStoreOptions {
  /**
   * How many windows it tracks at once. Default 50,000, the fleet's number. Past it, a request
   * that would start a new window is shed rather than counted.
   */
  maxKeys?: number;
}

/**
 * Windows in a `Map`, for one process. It counts per instance and starts again on every deploy,
 * which is right for a burst limit in front of an auth round trip. It cannot hold a limit a plan
 * sells: that has to survive a restart and a second process, so it goes in Redis.
 *
 * **It sheds at `maxKeys`, because dropping expired windows alone cannot bound a flood.** Every
 * spoofed address starts a new window, and inside one window none of them has expired. The copy
 * that dropped expired windows and had no refusal grew without limit. So a new window at the cap
 * is refused, and the windows already counting carry on.
 *
 * **The sweep runs once per expiry, not once per request.** The copies that shed walked the whole
 * map for every new key while it was full. Measured on a full 50,000-key map, that is about 3.8 ms
 * of event-loop time per shed request, so some 260 requests a second from spoofed addresses keep
 * one process busy doing nothing else. The shed meant to stop a flood was the flood's best tool.
 * This store remembers the earliest window still open and sweeps only after that has closed,
 * which puts a shed request at about a microsecond.
 */
export function memoryWindowStore({
  maxKeys = 50_000,
}: MemoryWindowStoreOptions = {}): MemoryWindowStore {
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextExpiry = Number.POSITIVE_INFINITY;

  function sweep(now: number): void {
    nextExpiry = Number.POSITIVE_INFINITY;
    for (const [key, window] of windows) {
      if (window.resetAt <= now) windows.delete(key);
      else nextExpiry = Math.min(nextExpiry, window.resetAt);
    }
  }

  return {
    canFail: false,
    async hit(key, resetAt, now) {
      let window = windows.get(key);
      if (!window) {
        if (windows.size >= maxKeys && now >= nextExpiry) sweep(now);
        if (windows.size >= maxKeys) return "full";
        window = { count: 0, resetAt };
        windows.set(key, window);
        nextExpiry = Math.min(nextExpiry, resetAt);
      }
      window.count += 1;
      return window.count;
    },
  };
}

export interface WindowLimit {
  /** Requests allowed in one window. The one after it is refused. */
  limit: number;
  windowMs: number;
}

interface WindowSpan {
  limit: number;
  /** When the window closes, in ms since the epoch. */
  resetAt: number;
  /** Seconds until then, rounded up, so never 0. What `Retry-After` should say. */
  retryAfterSecs: number;
}

export type WindowHit =
  | ({ outcome: "allowed"; allowed: true; count: number } & WindowSpan)
  | ({ outcome: "limited"; allowed: false; count: number } & WindowSpan)
  /** The memory store is full. This caller hit no limit, so say so in the refusal. */
  | ({ outcome: "shed"; allowed: false } & WindowSpan)
  /** The store did not answer. `allowed` is the limiter's own `whenStoreFails`. */
  | { outcome: "store-failed"; allowed: boolean; error: unknown };

/** A request the limit itself refused, which the product answers with its own 429. */
export type RefusedHit = Extract<WindowHit, { outcome: "limited" | "shed" }>;

/**
 * Count one request against `key` and say where it landed.
 *
 * `whenStoreFails` is required for any store but the memory one, and there is no default,
 * because the fleet uses both answers on purpose. A limiter guarding a promise, like a plan's
 * requests per minute, allows: refusing every paying caller over a Redis blip trades a real
 * outage for a limit nobody was hitting, and the bill is bounded elsewhere. A limiter guarding a
 * bill or a stranger's inbox, like a keyless demo or a form that sends mail, refuses: with the
 * store down there is no telling how much it already let through.
 *
 * Results, not throws: a refusal is the product's own 429 or 503, in its own words.
 */
export function hitWindow(
  store: MemoryWindowStore,
  key: string,
  rule: WindowLimit,
  now?: number,
): Promise<WindowHit>;
export function hitWindow(
  store: WindowStore,
  key: string,
  rule: WindowLimit & { whenStoreFails: StoreFailurePolicy },
  now?: number,
): Promise<WindowHit>;
export function hitWindow(
  store: WindowStore,
  key: string,
  rule: WindowLimit & { whenStoreFails?: StoreFailurePolicy },
  now?: number,
): Promise<WindowHit> {
  return countWindow(store, key, rule, now);
}

/**
 * {@link hitWindow} without the overloads, for `/hono`, whose options already tie the store to
 * the policy. Not exported from the package.
 */
export async function countWindow(
  store: WindowStore,
  key: string,
  { limit, windowMs, whenStoreFails }: WindowLimit & { whenStoreFails?: StoreFailurePolicy },
  now = Date.now(),
): Promise<WindowHit> {
  const index = Math.floor(now / windowMs);
  const resetAt = (index + 1) * windowMs;
  const span = { limit, resetAt, retryAfterSecs: Math.ceil((resetAt - now) / 1000) };
  let count: number | "full";
  try {
    count = await store.hit(`${key}:${index}`, resetAt, now);
  } catch (error) {
    // Only reachable without a policy on a store that says it cannot fail, which is a bug in
    // the store, so it surfaces as one.
    if (whenStoreFails === undefined) throw error;
    return { outcome: "store-failed", allowed: whenStoreFails === "allow", error };
  }
  if (count === "full") return { outcome: "shed", allowed: false, ...span };
  if (count > limit) return { outcome: "limited", allowed: false, count, ...span };
  return { outcome: "allowed", allowed: true, count, ...span };
}
