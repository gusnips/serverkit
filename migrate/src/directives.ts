/**
 * What a migration file asks of the runner, read from its leading comment block.
 *
 * Two directives, and they mean different things on purpose:
 *
 * - `-- migrate: manual` holds the file until a run passes `--manual`. It is for a change a person
 *   should watch: a long lock, a rewrite of a big table, a drop of customer data. It still runs in
 *   a transaction.
 * - `-- migrate: no-transaction` runs the file's statements one by one, outside a transaction. It
 *   is for statements Postgres refuses inside one, such as `CREATE INDEX CONCURRENTLY`.
 *
 * The runners this replaces had one marker, `-- @manual`, and it meant "gated but transactional"
 * in four of them and "gated and never in a transaction" in six. Any single meaning silently
 * changes one family's files: a `DROP COLUMN` on customer data, written for the first meaning,
 * would run with no transaction under the second. So the old marker is not read at all. It is an
 * error that names both replacements, on any line of the file, because a file that quietly stops
 * being gated is applied by the next deploy.
 *
 * Only the leading comment block counts. A comment further down that quotes a directive is prose
 * about it, and a whole-file search would flip that file's behaviour. A directive-shaped line after
 * the first statement is an error rather than a silent no-op, for the same reason.
 */

export interface Directives {
  /** Held until a run passes `--manual`. */
  manual: boolean;
  /** The text after `-- migrate: manual`, printed on the held file's `MANUAL_PENDING` line. */
  reason: string;
  /** Statements run one at a time, outside a transaction. */
  noTransaction: boolean;
}

const DIRECTIVE = /^--\s*migrate:\s*([A-Za-z-]*)\s*(.*)$/i;
const LEGACY_MANUAL = /^--\s*@manual\b/i;
const KNOWN = ["manual", "no-transaction"];

export function readDirectives(file: string, sql: string): Directives {
  const directives: Directives = { manual: false, reason: "", noTransaction: false };
  let inLeadingBlock = true;

  for (const [index, raw] of sql
    .replace(/^\uFEFF/, "")
    .split("\n")
    .entries()) {
    const line = raw.trim();
    if (inLeadingBlock && line !== "" && !line.startsWith("--")) inLeadingBlock = false;

    // Checked on every line, not only in the leading block: the runners that read it matched it
    // anywhere, so a marker below the first statement held that file, and it must not go quiet.
    if (LEGACY_MANUAL.test(line))
      throw new Error(
        `${file}, line ${String(index + 1)}: "-- @manual" is no longer read. Write ` +
          `"-- migrate: manual" at the top of the file to hold it until a run with --manual. Add ` +
          `"-- migrate: no-transaction" as well only if its statements cannot run in a transaction.`,
      );

    const match = DIRECTIVE.exec(line);
    if (!inLeadingBlock) {
      if (match)
        throw new Error(
          `${file}, line ${String(index + 1)}: "${line}" comes after the first SQL statement, so ` +
            `it would be ignored. Move it to the comment block at the top of the file.`,
        );
      continue;
    }

    if (!match) continue;

    const name = match[1] ?? "";
    if (name === "manual") {
      directives.manual = true;
      // `-- migrate: manual — drops a column` and `-- migrate: manual: drops…` read the same.
      directives.reason = (match[2] ?? "").replace(/^[—–:-]\s*/, "").trim();
    } else if (name === "no-transaction") {
      directives.noTransaction = true;
    } else {
      throw new Error(
        `${file}, line ${String(index + 1)}: unknown directive "${line}". The runner knows ` +
          KNOWN.map((known) => `"-- migrate: ${known}"`).join(" and ") +
          ".",
      );
    }
  }

  return directives;
}
