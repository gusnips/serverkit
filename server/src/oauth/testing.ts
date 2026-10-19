/**
 * An `OAuthStore` in memory, for your tests: the same contract as `createPgOAuthStore`, checked
 * against the same flows in the kit's own suite. Never serve with it. Every sign-in in progress
 * is lost when the process restarts, and two instances would not see each other's codes.
 *
 *     const store = createMemoryOAuthStore();
 *     const oauth = createOAuth({ ..., store });
 */
import type { OAuthGrant, OAuthStore } from "./index.ts";

export function createMemoryOAuthStore(): OAuthStore {
  const rows: OAuthGrant[] = [];
  const pending = (userCodeHash: string, now: Date) =>
    // The newest first, as the Postgres store orders by `created_at`.
    [...rows]
      .reverse()
      .find(
        (row) =>
          row.userCodeHash === userCodeHash &&
          row.kind === "device" &&
          row.status === "pending" &&
          row.expiresAt > now,
      );
  return {
    async insert(grant) {
      rows.push({ ...grant });
    },
    async spendCode(hash, now) {
      const row = rows.find((r) => r.hash === hash);
      if (!row || row.kind !== "code" || row.status !== "approved" || row.expiresAt <= now)
        return null;
      row.status = "used";
      return { ...row };
    },
    async findDevice(userCodeHash, now) {
      const row = pending(userCodeHash, now);
      return row ? { ...row } : null;
    },
    async decideDevice(userCodeHash, decision, now) {
      const row = pending(userCodeHash, now);
      if (!row) return false;
      row.status = decision.status;
      if (decision.status === "approved") {
        row.subject = decision.subject;
        row.keyName = decision.keyName;
      }
      return true;
    },
    async pollDevice(hash, clientId, now) {
      const row = rows.find(
        (r) => r.hash === hash && r.kind === "device" && r.clientId === clientId,
      );
      if (!row) return null;
      const before = { ...row };
      row.polledAt = now;
      if (row.status === "approved") row.status = "used";
      return before;
    },
    async prune(before) {
      const kept = rows.filter((row) => row.expiresAt >= before);
      const dropped = rows.length - kept.length;
      rows.splice(0, rows.length, ...kept);
      return dropped;
    },
  };
}
