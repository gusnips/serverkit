/**
 * The lines a deploy workflow greps. Change one here and you change every workflow that reads it.
 *
 * Before the package, each runner spelled these itself, and a copy edit broke a grep at least
 * once: a chain verifier kept requiring `Applying 000_baseline.sql (1 of 1)` after the folder
 * grew to six files, so it failed on every run. A plain token with no emoji and no prose
 * survives the next copy edit, and a test pins the exact bytes.
 */

/** Every line the runner prints starts with this. */
export const LOG_PREFIX = "[MIGRATIONS]";

/**
 * One line per gated file a run held back: `[MIGRATIONS] MANUAL_PENDING <file> — <reason>`.
 *
 * Workflows read it with `grep -F '[MIGRATIONS] MANUAL_PENDING'` and cut the prefix with
 * `${LINE#*MANUAL_PENDING }`. That pattern has no brackets in it on purpose: in a shell pattern
 * `[MIGRATIONS]` is a set that matches ONE character, so `${LINE#*[MIGRATIONS] }` cuts at the first
 * capital from that set followed by a space. On this line that happens to be the G of PENDING; on
 * the retired `⏸ Holding` line it was nowhere, and the annotation kept its prefix.
 */
export const MANUAL_PENDING = `${LOG_PREFIX} MANUAL_PENDING`;

/** `--status` prints this when a run would apply something: `… Status: PENDING <n>: <files>`. */
export const STATUS_PENDING = `${LOG_PREFIX} Status: PENDING`;

/** `--status` prints this when a run would apply nothing. */
export const STATUS_UP_TO_DATE = `${LOG_PREFIX} Status: up to date`;

export function manualPendingLine(file: string, reason: string): string {
  return reason ? `${MANUAL_PENDING} ${file} — ${reason}` : `${MANUAL_PENDING} ${file}`;
}

export function statusPendingLine(files: readonly string[]): string {
  return `${STATUS_PENDING} ${String(files.length)}: ${files.join(", ")}`;
}
