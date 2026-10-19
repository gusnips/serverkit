/**
 * `/oauth`'s grants, kept in Postgres: the table in the README, one row per code or device
 * sign-in, secrets only as hashes.
 *
 * Postgres and not memory, because every instance must see every grant: a code is spent on
 * whichever instance the client's token request lands on, and a device poll on whichever one the
 * script reaches. A copy that kept its sign-ins in a `Map` lost all of them on each deploy, and
 * worked only while one instance ran.
 *
 * Each change of state is one statement, so two requests cannot both win: two exchanges of one
 * code, two polls of one approved sign-in, two clicks on Approve.
 */
import type { Pool } from "pg";
import type { GrantStatus, OAuthGrant, OAuthStore } from "../oauth/index.ts";

export interface PgOAuthStoreOptions {
  /** The table from the README, with its schema if it has one: `app.oauth_grants`. */
  table: string;
}

/** A name or `schema.name`, because the table is written into the SQL, not passed as a value. */
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

interface GrantRow {
  hash: string;
  kind: "code" | "device";
  client_id: string;
  client_name: string;
  redirect_uri: string | null;
  code_challenge: string | null;
  user_code_hash: string | null;
  subject: string | null;
  key_name: string | null;
  status: GrantStatus;
  expires_at: Date;
  polled_at: Date | null;
}

const COLUMNS =
  "hash, kind, client_id, client_name, redirect_uri, code_challenge, user_code_hash, subject, key_name, status, expires_at, polled_at";

/**
 *     const oauth = createOAuth({ ..., store: createPgOAuthStore(pool, { table: "app.oauth_grants" }) });
 */
export function createPgOAuthStore(
  pool: Pick<Pool, "query">,
  options: PgOAuthStoreOptions,
): OAuthStore {
  const { table } = options;
  if (!TABLE_NAME.test(table))
    throw new TypeError(`The OAuth table must be a name or schema.name, not "${table}"`);

  // The newest pending sign-in with this code. A user code is 8 letters, so two live ones sharing
  // a code is a 1-in-10^10 chance; the newest is the one somebody is looking at.
  const pendingByUserCode = `SELECT hash FROM ${table}
    WHERE user_code_hash = $1 AND kind = 'device' AND status = 'pending' AND expires_at > $2
    ORDER BY created_at DESC LIMIT 1`;

  return {
    async insert(grant) {
      await pool.query(
        `INSERT INTO ${table} (${COLUMNS}) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          grant.hash,
          grant.kind,
          grant.clientId,
          grant.clientName,
          grant.redirectUri,
          grant.codeChallenge,
          grant.userCodeHash,
          grant.subject,
          grant.keyName,
          grant.status,
          grant.expiresAt,
          grant.polledAt,
        ],
      );
    },

    async spendCode(hash, now) {
      const { rows } = await pool.query<GrantRow>(
        `UPDATE ${table} SET status = 'used'
          WHERE hash = $1 AND kind = 'code' AND status = 'approved' AND expires_at > $2
      RETURNING ${COLUMNS}`,
        [hash, now],
      );
      return grantOf(rows[0]);
    },

    async findDevice(userCodeHash, now) {
      const { rows } = await pool.query<GrantRow>(
        `SELECT ${COLUMNS} FROM ${table} WHERE hash = (${pendingByUserCode})`,
        [userCodeHash, now],
      );
      return grantOf(rows[0]);
    },

    async decideDevice(userCodeHash, decision, now) {
      const approved = decision.status === "approved";
      // `status = 'pending'` is read again on the row itself: a second click that waited on the
      // first one's lock finds it decided and changes nothing.
      const { rowCount } = await pool.query(
        `UPDATE ${table} SET status = $3, subject = $4, key_name = $5
          WHERE hash = (${pendingByUserCode}) AND status = 'pending'`,
        [
          userCodeHash,
          now,
          decision.status,
          approved ? decision.subject : null,
          approved ? decision.keyName : null,
        ],
      );
      return (rowCount ?? 0) > 0;
    },

    async pollDevice(hash, clientId, now) {
      // The row is locked while it is read, so two polls of an approved sign-in queue up: the
      // first marks it used, and the second reads `used` and gets no key. `client_id` is in the
      // lock's WHERE, so another client's poll finds no row and changes nothing.
      const { rows } = await pool.query<GrantRow>(
        `WITH before AS (
           SELECT ${COLUMNS} FROM ${table}
            WHERE hash = $1 AND kind = 'device' AND client_id = $2
              FOR UPDATE
         )
         UPDATE ${table} AS grants
            SET polled_at = $3,
                status = CASE WHEN before.status = 'approved' THEN 'used' ELSE before.status END
           FROM before
          WHERE grants.hash = before.hash
      RETURNING ${COLUMNS.split(", ")
        .map((column) => `before.${column}`)
        .join(", ")}`,
        [hash, clientId, now],
      );
      return grantOf(rows[0]);
    },

    async prune(before) {
      const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE expires_at < $1`, [before]);
      return rowCount ?? 0;
    },
  };
}

function grantOf(row: GrantRow | undefined): OAuthGrant | null {
  if (!row) return null;
  return {
    hash: row.hash,
    kind: row.kind,
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    userCodeHash: row.user_code_hash,
    subject: row.subject,
    keyName: row.key_name,
    status: row.status,
    expiresAt: row.expires_at,
    polledAt: row.polled_at,
  };
}

/** What the store reads and writes, by column, as `format_type` names it. */
const EXPECTED: Record<string, { type: string; takesNull: boolean }> = {
  hash: { type: "text", takesNull: false },
  kind: { type: "text", takesNull: false },
  client_id: { type: "text", takesNull: false },
  client_name: { type: "text", takesNull: false },
  redirect_uri: { type: "text", takesNull: true },
  code_challenge: { type: "text", takesNull: true },
  user_code_hash: { type: "text", takesNull: true },
  subject: { type: "text", takesNull: true },
  key_name: { type: "text", takesNull: true },
  status: { type: "text", takesNull: false },
  expires_at: { type: "timestamp with time zone", takesNull: false },
  polled_at: { type: "timestamp with time zone", takesNull: true },
  created_at: { type: "timestamp with time zone", takesNull: false },
};

/**
 * What is wrong with your grants table, measured against what `createPgOAuthStore` reads and
 * writes: `[]` when nothing is. Run it in the test that applies your migrations, so a migration
 * that drifted from the README's fails there and not at somebody's first sign-in.
 *
 *     expect(await checkOAuthTable(pool, { table: "app.oauth_grants" })).toEqual([]);
 */
export async function checkOAuthTable(
  pool: Pick<Pool, "query">,
  options: PgOAuthStoreOptions,
): Promise<string[]> {
  const { table } = options;
  if (!TABLE_NAME.test(table))
    throw new TypeError(`The OAuth table must be a name or schema.name, not "${table}"`);
  const { rows } = await pool.query<{
    name: string;
    type: string;
    not_null: boolean;
    has_default: boolean;
  }>(
    `SELECT attname AS name, format_type(atttypid, NULL) AS type, attnotnull AS not_null,
            atthasdef AS has_default
       FROM pg_attribute WHERE attrelid = to_regclass($1) AND attnum > 0 AND NOT attisdropped`,
    [table],
  );
  if (rows.length === 0)
    return [`${table} does not exist. Add the README's CREATE TABLE as a migration.`];

  const problems: string[] = [];
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const column = rows.find((row) => row.name === name);
    if (!column) problems.push(`${table}.${name} is missing (${expected.type}).`);
    else if (column.type !== expected.type)
      problems.push(`${table}.${name} is ${column.type}; the store uses ${expected.type}.`);
    else if (expected.takesNull && column.not_null)
      problems.push(`${table}.${name} is NOT NULL, but the store leaves it empty on some rows.`);
  }
  // The store never writes it, and orders device sign-ins by it.
  const created = rows.find((row) => row.name === "created_at");
  if (created && !created.has_default)
    problems.push(`${table}.created_at needs DEFAULT now(): the store never writes it.`);
  return problems;
}
