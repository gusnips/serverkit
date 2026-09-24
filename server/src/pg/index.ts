/**
 * `@gusnips/server/pg`: the two decisions every backend makes when it creates a node-postgres
 * Pool, and that eleven of them made by hand — plus one almost none of them made, which is what
 * a `date` column reads as.
 *
 *     const pool = createPgPool({
 *       connectionString: env.DATABASE_URL,
 *       onIdleError: (error) => logger.error("[pg] idle client error — client discarded", { error }),
 *     });
 *
 * Behind a subpath because it imports `pg`, which the main entry does not and a Worker adopter
 * could not run. Note the difference from the purity guard's rule: nothing in HERE reaches for
 * `node:*`, so the source stays checkable; what is Node-only is the PEER, and an optional peer
 * behind a subpath is installed only by an adopter who imports the thing that uses it.
 *
 * The SSL rule is not here. `@gusnips/migrate` exports `pgSsl`, which nine hand-written copies
 * of this fleet agreed on byte-for-byte, and it already carries the finding that their comments
 * did NOT agree on why. Spread it in beside `connectionString`.
 */
import { Pool, TypeOverrides, types, type CustomTypesConfig, type PoolConfig } from "pg";

/**
 * How long a caller waits for a free connection before failing loudly.
 *
 * Ten seconds is long enough that a merely BUSY pool does not fail, and short enough that a
 * saturated one says so. The number is a judgement; the default existing at all is not — see
 * {@link createPgPool}.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export interface PgPoolOptions extends PoolConfig {
  /**
   * Required, because a Pool with no `error` listener is a process that exits.
   *
   * A Pool is an EventEmitter that emits `error` when the server closes an IDLE client — a
   * Postgres restart, a failover, a cert reload, a pooler timeout, an SSH tunnel dropping (which
   * is how a DATABASE_URL reaches a dev machine). With no listener, Node escalates that to an
   * uncaught exception, and a backend whose crash handler exits the process is then taken down
   * by a connection nobody was using. The pool has already discarded and replaced the client by
   * the time this fires, so logging is the entire correct response.
   *
   * Eleven backends in this fleet wrote that listener and eleven wrote a comment saying
   * "MANDATORY, not hygiene". Expressing it as a required field is what makes the twelfth unable
   * to forget.
   */
  onIdleError: (error: Error) => void;

  /**
   * What a `date` column, and a `date[]`, reads as. Default `"string"`: the day as Postgres wrote
   * it, `"2026-09-23"`.
   *
   * A `date` has no time and no zone, and node-postgres turns it into a Date at local MIDNIGHT —
   * so one row is a different instant on every box. Measured on pg-types 2.2.0: `'2026-09-23'`
   * reads as `2026-09-23T00:00:00.000Z` under `TZ=UTC`, `T03:00:00.000Z` under
   * `TZ=America/Sao_Paulo`, and `2026-09-22T22:00:00.000Z` under `TZ=Europe/Berlin`, where
   * `toISOString().slice(0, 10)` gives back the day before. A string cannot move, and it is what
   * `@gusnips/migrate`'s `db-types` already writes into the row types, so the types stop lying.
   *
   * Set on this pool only, through pg's per-client `types`, never the process-wide
   * `types.setTypeParser`: another pool or library in the same process still gets what it asked
   * for. Only `date` changes — a `timestamptz` Date is a real instant. `"date"` hands both back to
   * pg's own parser, or to the `types` you pass.
   */
  dateColumns?: "string" | "date";
}

/**
 * A node-postgres Pool that fails loudly instead of stalling in silence.
 *
 * **The default this exists for.** With no `connectionTimeoutMillis`, a caller that finds the
 * pool full is pushed onto the pending queue with NO TIMER — read in `pg-pool@3.14.0`, not
 * inferred:
 *
 *     if (!this.options.connectionTimeoutMillis) {
 *       this._pendingQueue.push(new PendingItem(response.callback))
 *       return result
 *     }
 *
 * node-postgres defaults `max` to 10, so ten slow queries at once are enough: everything after
 * them — auth, billing, the workers, `/health` — waits forever with no error, no log and no
 * metric. It is not a 500, it is silence, which is why it survives in a codebase. Measured
 * across this fleet: **one backend of eleven bounded it**, and that one only because a feature
 * of its own held a connection across an advisory lock and made the latent case live.
 *
 * Pass `connectionTimeoutMillis: 0` to opt back into waiting forever — a batch job that would
 * rather queue than fail is a real case. It is spelled out here so that choosing it is a
 * decision rather than the shape of an omission.
 *
 * Everything else is `PoolConfig`, passed straight through: `max`, `ssl` (from
 * `@gusnips/migrate`'s `pgSsl`), `options: "-c search_path=app"`, and the rest.
 *
 * The pool itself is NOT a singleton here. Every copy in the fleet wrapped one in a module-level
 * `let`, and that is the app's lifecycle to own — a package that holds it decides when your
 * process can exit.
 */
export function createPgPool({
  onIdleError,
  dateColumns = "string",
  ...config
}: PgPoolOptions): Pool {
  const pool = new Pool({
    connectionTimeoutMillis: DEFAULT_CONNECT_TIMEOUT_MS,
    ...config,
    types: dateColumns === "string" ? datesAsText(config.types) : config.types,
  });
  pool.on("error", onIdleError);
  return pool;
}

/** OIDs from `pg_type`. A `date[]` goes through `text[]`'s parser, which reads any array as its
 *  elements' text, quoting and `NULL` included. `number` because pg-types' `TypeId` lists only
 *  the base types, while its `getTypeParser` takes any OID. */
const DATE = 1082;
const DATE_ARRAY = 1182;
const TEXT_ARRAY: number = 1009;

function datesAsText(base: CustomTypesConfig | undefined): TypeOverrides {
  const overrides = new TypeOverrides(base);
  overrides.setTypeParser(DATE, "text", (value) => value);
  overrides.setTypeParser(DATE_ARRAY, "text", types.getTypeParser(TEXT_ARRAY, "text"));
  return overrides;
}

export interface PingOptions {
  /** How long to wait before reporting the database as unreachable. */
  timeoutMs?: number;
  /** The failure, for a log line. A ping that answers `false` and says nothing is a `/health`
   *  that reports a dependency down without ever saying why. */
  onError?: (error: unknown) => void;
}

/**
 * Readiness: a bounded `SELECT 1`, answering `false` rather than throwing so `/health` can
 * report the dependency by name.
 *
 * **Bounded is the whole point.** Four backends in this fleet run this query raw, so a hung
 * database hangs `/health` — which is the one thing `/health` exists not to do, since an
 * orchestrator reads a timeout as "unknown" where it would have read `false` as "replace this
 * container". `connectionTimeoutMillis` does not cover it either: that bounds getting a
 * connection, not the query once you hold one.
 *
 * The race leaks the query — it keeps running to completion on its own connection. For
 * `SELECT 1` that is free and the alternative (a `statement_timeout`, a cancel request) costs
 * more than the thing it protects. The timer IS cleared, which the one bounded copy in the fleet
 * forgot: an uncleared 2s timer per health check keeps the event loop busy in a process that is
 * probed every few seconds.
 */
export async function pingPool(
  /** Structural rather than `Pool`, so this says what it needs and a test can hand it a stub. */
  pool: Pick<Pool, "query">,
  { timeoutMs = 2_000, onError }: PingOptions = {},
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`postgres ping timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
    return true;
  } catch (error) {
    onError?.(error);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export { createIdempotency } from "./idempotency.ts";
export type { IdempotencyOptions, IdempotencyScope, IdempotentOutcome } from "./idempotency.ts";
