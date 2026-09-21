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
 * repo. The `error` listener is required here for the same reason `onIdleError` is required on
 * `createPgPool`.
 */
import IORedis, { type RedisOptions } from "ioredis";

export interface CreateRedisOptions extends RedisOptions {
  /**
   * `REDIS_URL`. Omit it to connect from the other options instead — `host`, `port`, `db`,
   * `username`, `password` — which is how three backends in this fleet configure theirs.
   */
  url?: string;
  /**
   * Required, because an ioredis client with no `error` listener is a process that exits.
   *
   * ioredis emits `error` on every failed connect, and an EventEmitter with no `error` listener
   * throws. Through the `uncaughtException` handler a backend installs for crash visibility,
   * that is a process exit over a Redis blip — the client reconnects on its own, so logging is
   * the entire correct response.
   *
   * Four backends in this fleet wrote that listener, and all four wrote a comment saying it "is
   * not optional". Expressing it as a required field is what makes the fifth unable to forget.
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
 * failing. {@link pingRedis} is the worked example. One backend in this fleet enqueues inbound
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
  const client = url
    ? new IORedis(url, { maxRetriesPerRequest: null, ...options })
    : new IORedis({ maxRetriesPerRequest: null, ...options });
  client.on("error", onError);
  return client;
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
