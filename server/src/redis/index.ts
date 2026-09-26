/**
 * `@gusnips/server/redis`: the connection every backend on this stack opens for BullMQ, and the
 * bounded probes that make it safe to read from.
 *
 *     const redis = createRedis({
 *       url: env.REDIS_URL,
 *       onError: (error) => logger.error("[redis] connection error", { error }),
 *     });
 *
 * Behind a subpath because it imports `ioredis`, which the main entry does not. Same rule as
 * `/pg`: nothing in here reaches for `node:*`, so the source stays checkable by the purity
 * guard; what is Node-only is the PEER, and an optional peer behind a subpath is installed only
 * by an adopter who imports the thing that uses it.
 *
 * The connection factory this replaces was BYTE-IDENTICAL in the four backends it came from,
 * comment included — and one of those comments says, out loud, that it was copied from a sibling
 * repo. Including the part of the comment that was wrong: see `onError`.
 */
import IORedis, { type RedisOptions } from "ioredis";

export { redisWindowStore } from "./window-store.ts";
export type { RedisWindowStoreOptions, WindowPipeline } from "./window-store.ts";

export interface CreateRedisOptions extends RedisOptions {
  /**
   * `REDIS_URL`. Omit it to connect from the other options instead — `host`, `port`, `db`,
   * `username`, `password` — which is how three backends in this fleet configure theirs.
   */
  url?: string;
  /**
   * Required, because without it a failed connect leaves the app's log silent and prints an
   * unstructured stack to stderr instead.
   *
   * **The reason four backends give for this is wrong, and it was measured rather than
   * reasoned.** All four say an EventEmitter with no `error` listener throws, so a Redis blip
   * becomes a process exit through the `uncaughtException` handler a backend installs for crash
   * visibility. That rule is true of an EventEmitter and false of ioredis: `silentEmit` in
   * `Redis.js` checks `this.listeners(eventName).length` and, finding none, calls
   * `console.error("[ioredis] Unhandled error event:", ...)` and returns — it never emits, so
   * Node's throw is unreachable. Measured on ioredis 5.10.1 (what the whole fleet runs) under
   * both bun 1.3.8 and node 22: the process survives and `uncaughtException` never fires.
   *
   * It stays required for the reason that survives. That `console.error` is a bare stack on
   * stderr, outside whatever logger the app ships its other failures through, and `silentEmit`
   * drops the event entirely once the client's status is `end`. A dependency that has stopped
   * answering should say so where an operator is already looking.
   *
   * Note the sibling rule is NOT wrong, and it was checked the same way rather than assumed:
   * `pg-pool` calls `pool.emit("error", err, client)` with no listener-count guard anywhere, so
   * `createPgPool`'s `onIdleError` really is standing between an idle-client error and a crash.
   * Copying one library's sentence onto another is what produced the false half.
   */
  onError: (error: Error) => void;
}

/**
 * One ioredis connection, shared by the queues, the limiters and the health probe.
 *
 * **`maxRetriesPerRequest: null` is the default, and it is the opposite kind of default from
 * `createPgPool`'s.** There the default makes an unbounded wait bounded; here it makes commands
 * wait FOREVER, because BullMQ requires it — its blocking reads must never be cut short by a
 * retry limit. That is not a mistake and every copy in this fleet sets it, but it has a
 * consequence worth stating once instead of rediscovering:
 *
 * **Every read on this connection must carry its own bound.** A `ping`, a cache lookup, a
 * limiter check, a `queue.add()` — with Redis down, each waits indefinitely rather than
 * failing. {@link pingRedis} is the worked example. An `add()` needs more than a bound: a timer
 * ends the request, and the job is still added once Redis comes back (measured, 35 seconds down),
 * so check `status === "ready"` before adding. One backend in this fleet enqueues inbound
 * webhooks on a connection like this with nothing bounding the enqueue, so during a Redis outage
 * each webhook holds its HTTP connection until the caller gives up, and its `/health` — which
 * probes Postgres only — stays green throughout.
 *
 * Pass `maxRetriesPerRequest: 3` for a connection that serves ordinary commands rather than
 * BullMQ's blocking ones. Everything else is `RedisOptions`, passed straight through.
 *
 * The client is NOT a singleton here. Every copy in the fleet wrapped one in a module-level
 * `let`, and that is the app's lifecycle to own — a package that holds it decides when your
 * process can exit.
 */
export function createRedis({ url, onError, ...options }: CreateRedisOptions): IORedis {
  if (url) refuseQueryOptions(url);
  const client = url
    ? new IORedis(url, { maxRetriesPerRequest: null, ...options })
    : new IORedis({ maxRetriesPerRequest: null, ...options });
  client.on("error", onError);
  return client;
}

/**
 * ioredis reads options from the URL's query, lets them beat the options passed beside the URL,
 * and keeps each value as a string. So `?maxRetriesPerRequest=7` replaces the `null` BullMQ needs,
 * and `?enableOfflineQueue=false` is the string "false", which ioredis reads as on (measured on
 * 5.11.1). Every option has a typed place in `createRedis`'s own, so the URL may carry none.
 *
 * The message names no key: in a URL whose password holds an unencoded `?`, the "key" is the
 * rest of the password.
 */
function refuseQueryOptions(url: string): void {
  const at = url.indexOf("?");
  if (at >= 0 && new URLSearchParams(url.slice(at + 1)).size > 0)
    throw new TypeError(
      'The Redis URL has options after its "?". ioredis lets those beat the options you pass, ' +
        'and reads each one as a string, so "false" turns an option on. Take them out of the URL ' +
        "and pass them to createRedis, such as { family: 6 }.",
    );
}

export interface RedisPingOptions {
  /** How long to wait before reporting Redis as unreachable. */
  timeoutMs?: number;
  /** The failure, for a log line. A ping that answers `false` and says nothing is a `/health`
   *  that reports a dependency down without ever saying why. */
  onError?: (error: unknown) => void;
}

/**
 * Readiness: a bounded `PING`, answering `false` rather than throwing so `/health` can report
 * the dependency by name.
 *
 * **The bound is doing real work here, more than it is for Postgres.** The connection above is
 * deliberately unbounded (see {@link createRedis}), so an unbounded `ping()` on it never
 * returns while Redis is down — it does not fail, it waits. Four backends in this fleet bound it
 * exactly this way and are safe only because of it; **all four then forgot to clear the timer**,
 * which leaves a pending 2s timer per health check in a process something probes every few
 * seconds. This clears it in a `finally`.
 *
 * The race leaks the `PING` itself — it stays outstanding on the connection. For a `PING` that
 * is free, and the alternative costs more than the thing it protects.
 */
export async function pingRedis(
  /** Structural rather than `IORedis`, so this says what it needs and a test can hand it a stub. */
  redis: Pick<IORedis, "ping">,
  { timeoutMs = 2_000, onError }: RedisPingOptions = {},
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pong = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`redis ping timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return pong === "PONG";
  } catch (error) {
    onError?.(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export interface AssertRedisOptions extends RedisPingOptions {
  /**
   * The connection string, used only to name the HOST in the error — never its password, which
   * is why this takes the URL and parses it rather than taking a string to interpolate.
   */
  url?: string;
  /**
   * One sentence appended to the message: what to DO about it, here.
   *
   * The generic half of this error states what failed and its likely cause, and a package can
   * know no more than that. The fix is local — "start it (the dev compose runs one)" names a
   * command that exists in one repo and not the next. Three backends wrote this gate; two said
   * "check REDIS_URL" and the third named the tool that starts one, and the third is the only
   * message a reader can act on without knowing the repo already.
   */
  hint?: string;
}

/**
 * Boot gate: a process whose queues can never connect must not sit there looking healthy.
 *
 * Three backends in this fleet call this from a worker's entry point, before it starts consuming.
 * Without it the worker boots, reports itself up, and quietly consumes nothing — which looks
 * exactly like an empty queue.
 *
 * The default here is longer than {@link pingRedis}'s on purpose: a readiness probe runs every
 * few seconds and wants a fast answer, where a boot gate runs once against a Redis that may
 * still be starting beside it.
 */
export async function assertRedisReachable(
  redis: Pick<IORedis, "ping">,
  { url, timeoutMs = 5_000, onError, hint }: AssertRedisOptions = {},
): Promise<void> {
  if (await pingRedis(redis, { timeoutMs, onError })) return;
  throw new Error(
    `Redis at ${redisHost(url)} did not answer PING within ${timeoutMs} ms. It is down, or the URL is wrong.` +
      (hint ? ` ${hint}` : ""),
  );
}

export interface QuitRedisOptions {
  /** How long `QUIT` may take before the socket is simply closed. */
  timeoutMs?: number;
}

/**
 * Shutdown: a bounded `QUIT`, then the socket closed whatever happened. Never throws.
 *
 * **A bare `quit()` can hold a drain until the process manager kills it, two ways.** With Redis
 * unreachable and a command waiting in ioredis's offline queue — the `PING` a health probe gave up
 * on — `quit()` resolves only once that queue is empty, and it never empties. And with Redis
 * frozen rather than gone, a paused process or a stalled VM, the socket stays open and `QUIT` is
 * never answered. Either way every step after it, Postgres included, never runs. Two backends in
 * the fleet found it on the same day; both had `quit().catch(() => disconnect())`, which catches a
 * rejection and not a hang.
 *
 * A connection that is not ready has nothing to flush, so it closes at once.
 */
export async function quitRedis(
  redis: Pick<IORedis, "status" | "quit" | "disconnect">,
  { timeoutMs = 1_000 }: QuitRedisOptions = {},
): Promise<void> {
  if (redis.status !== "ready") {
    redis.disconnect();
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = await Promise.race([
    redis.quit().then(
      () => true,
      () => false,
    ),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  if (!answered) redis.disconnect();
}

/** The host of a Redis URL, and never its password. Answers a readable placeholder rather than
 *  throwing, because this only ever runs while something is already failing. */
function redisHost(url: string | undefined): string {
  if (!url) return "(no url given)";
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable url)";
  }
}
