import type { WindowStore } from "../rate-limit.ts";

/** The slice of ioredis this needs, so a test can hand it a stub. An `IORedis` fits as it is. */
export interface WindowPipeline {
  incr(key: string): WindowPipeline;
  pexpire(key: string, milliseconds: number): WindowPipeline;
  exec(): Promise<[error: Error | null, result: unknown][] | null>;
}

/** The client, as far as this needs it. An `IORedis` fits as it is; a stub needs only `multi`. */
export interface WindowRedis {
  multi(): WindowPipeline;
  /** ioredis's connection state. A client without one is treated as always connected. */
  status?: string;
  once?(event: "ready" | "close", listener: () => void): unknown;
  removeListener?(event: "ready" | "close", listener: () => void): unknown;
}

export interface RedisWindowStoreOptions {
  /**
   * How long a count may take before it is a store failure, which the limiter then allows or
   * refuses by its own `whenStoreFails`. Required, because on the connection `createRedis` makes
   * by default a count against a Redis that is down never answers at all.
   */
  timeoutMs: number;
  /** Put before every key. Default `"rl:"`, which is what the fleet's Redis limiters use. */
  prefix?: string;
}

/**
 * Rate-limit windows in Redis, so a limit holds across a restart and a second process.
 *
 * **One MULTI counts the request and re-arms the expiry.** The copy that sent `INCR` and then
 * `EXPIRE` only on the first hit can lose the second call to a crash or a dropped connection,
 * and that key then never expires, so its subject is over the limit forever. Its own fallback,
 * "no TTL, so say a full window", hid that behind a wait that looked normal.
 *
 * **Three limiters in the fleet said "fails open" and hung instead.** Their `catch` was never
 * reached: the shared connection has `maxRetriesPerRequest: null`, which BullMQ needs, so a
 * command against a Redis that is down waits for it to come back. Measured against a closed
 * port, the MULTI was still pending after 15 seconds, and so was every request behind it. So
 * `timeoutMs` is required and the timer is cleared either way.
 *
 * The timeout is the backstop, not the fix. A MULTI that lost the race stays queued on that
 * connection and runs when Redis returns. Give the limiter a connection that fails at once
 * instead. This is the donor's shape that failed fastest, in 1 ms against the closed port:
 *
 *     const limits = createRedis({
 *       url: env.REDIS_URL,
 *       maxRetriesPerRequest: 1,
 *       enableOfflineQueue: false,
 *       commandTimeout: 1_000,
 *       onError: (error) => logger.error("[redis] limiter connection", { error }),
 *     });
 *
 * **That connection refuses a command while it is still opening, so a count waits for it.**
 * Without the offline queue, ioredis answers "Stream isn't writeable" to anything sent before the
 * first `ready`, so the first count after every boot failed, and after every reconnect too. A
 * proxy that holds requests through a restart delivers the first one into exactly that window: an
 * allowing limiter let it through uncounted, and a refusing one answered 503. So a count sent while
 * the connection is opening waits for `ready` or `close`, whichever comes first, inside the same
 * `timeoutMs`. Ending on `close` is what keeps "fails at once": with Redis down, the attempt closes
 * in about a millisecond and the count fails then, instead of at the deadline.
 */
export function redisWindowStore(
  redis: WindowRedis,
  { timeoutMs, prefix = "rl:" }: RedisWindowStoreOptions,
): WindowStore {
  return {
    canFail: true,
    async hit(key, resetAt, now) {
      const name = prefix + key;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stopWaiting: (() => void) | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Redis did not count the request within ${timeoutMs} ms.`)),
            timeoutMs,
          );
        });
        if (redis.status === "connecting" || redis.status === "connect") {
          const wait = whenOpened(redis);
          stopWaiting = wait.stop;
          await Promise.race([wait.opened, deadline]);
        }
        const replies = await Promise.race([
          redis
            .multi()
            .incr(name)
            // A second past the window's end, so a count that lands just as the window
            // closes still finds its key.
            .pexpire(name, Math.ceil(resetAt - now) + 1_000)
            .exec(),
          deadline,
        ]);
        const [error, count] = replies?.[0] ?? [null, undefined];
        if (error) throw error;
        if (typeof count !== "number")
          throw new Error(`Redis answered INCR with ${String(count)}, not a number.`);
        return count;
      } finally {
        clearTimeout(timer);
        stopWaiting?.();
      }
    },
  };
}

/** Settles on the connection's first `ready` or `close`, and says how to stop listening. */
function whenOpened(redis: WindowRedis): { opened: Promise<void>; stop: () => void } {
  let done = (): void => {};
  const opened = new Promise<void>((resolve) => {
    done = resolve;
  });
  redis.once?.("ready", done);
  redis.once?.("close", done);
  return {
    opened,
    stop: () => {
      redis.removeListener?.("ready", done);
      redis.removeListener?.("close", done);
    },
  };
}
