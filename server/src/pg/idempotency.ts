/**
 * A retry that does not run twice: the `Idempotency-Key` replay, kept in Postgres.
 *
 * A client that lost the answer to a write (a timeout, a dropped connection) cannot tell whether
 * the write happened. If it sent a key of its own, the retry gets the first answer back instead of
 * sending a second message or charging a second time.
 *
 * Two backends wrote this in the same week, and each got right what the other got wrong:
 * - **A claim whose run died is taken over.** One copy kept it "running" until the daily prune, so
 *   one deploy mid-request answered every retry with "still running" for up to 24 hours. Its own
 *   SDK reuses one key across retries, so the SDK was the caller that got stuck.
 * - **A failed save does not fail the request.** The work happened. One copy answered a failed
 *   save with a 5xx, which is the answer a client retries, on a key it had just left claimed.
 * - **The fingerprint is canonical JSON.** One copy hashed `JSON.stringify` of its parsed input,
 *   which is stable only while the validator writes keys in schema order.
 * - **The key comes from a header or an argument.** An MCP tool call has no headers of its own,
 *   so the copy that read only the header gave its MCP door no replay at all.
 *
 * Two more that neither had:
 * - **A lease.** A run that outlives `abandonedSecs` is taken over. When the first run finishes
 *   after all, its save and its release must not touch the row the second run now holds.
 * - **A `Date` is fingerprinted as its value.** One copy sorted keys by walking objects, which
 *   turns every `Date` into `{}`, so two requests that differ only in a date looked the same.
 *
 * Both copies chose Postgres over Redis for the same reason: losing this row is a double spend.
 */
import type { Pool } from "pg";
import { sha256Hex } from "../crypto.ts";

export interface IdempotencyOptions {
  /** The table from the README, with its schema if it has one: `app.idempotency_keys`. */
  table: string;
  /**
   * Called when an answer could not be kept or a claim could not be let go. The request still
   * answers, because the work happened, and an error now would invite the retry that runs it
   * again. Log it. Must not throw.
   */
  onError: (error: unknown) => void;
  /** How long an answer is replayed. After that, the same key is a new request. Default: a day. */
  replaySecs?: number;
  /**
   * How long a claim with no answer is held before a retry takes it over, because the process
   * that made it died. Set it well past your slowest operation: a run still going when it passes
   * can run twice. Default: 15 minutes.
   */
  abandonedSecs?: number;
}

export interface IdempotencyScope {
  /** Whose key it is: a workspace, an account, an API key. Owners never see each other's answers. */
  owner: string;
  /** The operation's name. The same key on another operation is a mismatch, not a new request. */
  operation: string;
  /** The client's key, from an `Idempotency-Key` header or a tool argument. None: just run. */
  key: string | null | undefined;
}

export type IdempotentOutcome<T> =
  /** This request ran the work. */
  | { kind: "ran"; answer: T }
  /** A request with this key already answered. This is that answer, read back as JSON. */
  | { kind: "replayed"; answer: unknown }
  /** A request with this key has not answered yet. Answer 409 with a short `Retry-After`. */
  | { kind: "running" }
  /** The key was used for another operation or other input. Answer 422: the fix is a new key. */
  | { kind: "mismatch" };

/** A name or `schema.name`, because the table is written into the SQL, not passed as a value. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

/**
 * The replay store. Run each write through `run`, and call `prune` once an hour or once a night.
 *
 *     const idempotency = createIdempotency(pool, {
 *       table: "app.idempotency_keys",
 *       onError: (error) => logger.error("idempotency store failed", { error }),
 *     });
 */
export function createIdempotency(pool: Pick<Pool, "query">, options: IdempotencyOptions) {
  const { table, onError, replaySecs = 86_400, abandonedSecs = 900 } = options;
  if (!TABLE_NAME.test(table))
    throw new TypeError(`The idempotency table must be a name or schema.name, not "${table}"`);

  // One statement, so two requests with one key cannot both see it free. A fresh key inserts. An
  // expired row is taken over whatever it held. A claim with no answer is taken over only past
  // `abandonedSecs`, and only by the same request: until it expires, the key still means that one.
  const claimSql = `INSERT INTO ${table} AS held (owner, key_hash, fingerprint, lease)
      VALUES ($1, $2, $3, $4)
    ON CONFLICT (owner, key_hash) DO UPDATE
      SET fingerprint = EXCLUDED.fingerprint, lease = EXCLUDED.lease, answer = NULL,
          created_at = now()
    WHERE held.created_at < now() - make_interval(secs => $5)
       OR (held.answer IS NULL AND held.fingerprint = EXCLUDED.fingerprint
           AND held.created_at < now() - make_interval(secs => $6))`;
  // `answer IS NULL` is read in SQL: node-postgres parses a stored JSON `null` to `null` too, and
  // an answer of `null` is an answer, not a claim still running.
  const readSql = `SELECT fingerprint, answer, answer IS NULL AS running FROM ${table}
    WHERE owner = $1 AND key_hash = $2`;
  const saveSql = `UPDATE ${table} SET answer = $4::json
    WHERE owner = $1 AND key_hash = $2 AND lease = $3`;
  const releaseSql = `DELETE FROM ${table} WHERE owner = $1 AND key_hash = $2 AND lease = $3`;
  const pruneSql = `DELETE FROM ${table} WHERE (owner, key_hash) IN (
    SELECT owner, key_hash FROM ${table}
     WHERE created_at < now() - make_interval(secs => $1) LIMIT $2)`;

  return {
    /**
     * Runs `work` once per key. `input` is what the request asked for, after parsing: the same key
     * with other input is a mismatch. Check who may call the operation BEFORE this, because a
     * replay hands back a stored answer.
     *
     * A throw from `work` lets the claim go and is rethrown, so a retry with the same key runs.
     */
    async run<T>(
      scope: IdempotencyScope,
      input: unknown,
      work: () => Promise<T>,
    ): Promise<IdempotentOutcome<T>> {
      if (!scope.key) return { kind: "ran", answer: await work() };
      const { owner, operation } = scope;
      // The key is stored hashed, so a key of any length fits the index and needs no limit.
      const [keyHash, fingerprint] = await Promise.all([
        sha256Hex(scope.key),
        sha256Hex(canonicalJson([operation, input])),
      ]);
      const lease = crypto.randomUUID();
      const claimed = await pool.query(claimSql, [
        owner,
        keyHash,
        fingerprint,
        lease,
        replaySecs,
        abandonedSecs,
      ]);
      if (claimed.rowCount !== 1) {
        const { rows } = await pool.query<{
          fingerprint: string;
          answer: unknown;
          running: boolean;
        }>(readSql, [owner, keyHash]);
        const held = rows[0];
        // Gone between the two statements: its run failed and let go. The next try claims it.
        if (!held) return { kind: "running" };
        if (held.fingerprint !== fingerprint) return { kind: "mismatch" };
        return held.running ? { kind: "running" } : { kind: "replayed", answer: held.answer };
      }

      let answer: T;
      try {
        answer = await work();
      } catch (error) {
        await pool.query(releaseSql, [owner, keyHash, lease]).catch(onError);
        throw error;
      }
      try {
        // `json`, not `jsonb`: jsonb reorders an object's keys, and a replay should read the same.
        const saved = await pool.query(saveSql, [
          owner,
          keyHash,
          lease,
          JSON.stringify(answer) ?? "null",
        ]);
        if (saved.rowCount !== 1)
          onError(
            new Error(
              `The answer to ${operation} was not kept: the work ran past abandonedSecs ` +
                `(${abandonedSecs}s), a retry took its key over, and may have run it again.`,
            ),
          );
      } catch (error) {
        onError(error);
      }
      return { kind: "ran", answer };
    },

    /** Deletes answers past `replaySecs`, `batch` rows at a time, and returns how many went. */
    async prune(batch = 1000): Promise<number> {
      let total = 0;
      for (;;) {
        const deleted = (await pool.query(pruneSql, [replaySecs, batch])).rowCount ?? 0;
        total += deleted;
        if (deleted < batch) return total;
      }
    },
  };
}

/**
 * JSON with every object's keys in sorted order, so two clients that write the same fields in a
 * different order send the same request. The replacer sees each value after its `toJSON`, so a
 * `Date` is compared by its value.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, held: unknown) =>
    held !== null && typeof held === "object" && !Array.isArray(held)
      ? Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : held,
  );
}
