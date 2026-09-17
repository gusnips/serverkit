import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LOG_PREFIX,
  MANUAL_PENDING,
  manualPendingLine,
  STATUS_PENDING,
  STATUS_UP_TO_DATE,
  statusPendingLine,
} from "./lines.ts";

/**
 * Deploy workflows grep these exact bytes. A failure here means a workflow somewhere stopped
 * seeing a held migration or a pending schema, and nothing else would say so.
 */
describe("machine lines", () => {
  it("keeps the exact strings workflows grep", () => {
    expect(LOG_PREFIX).toBe("[MIGRATIONS]");
    expect(MANUAL_PENDING).toBe("[MIGRATIONS] MANUAL_PENDING");
    expect(STATUS_PENDING).toBe("[MIGRATIONS] Status: PENDING");
    expect(STATUS_UP_TO_DATE).toBe("[MIGRATIONS] Status: up to date");
  });

  it("formats the held and pending lines", () => {
    expect(manualPendingLine("013_drop.sql", "drops customer columns")).toBe(
      "[MIGRATIONS] MANUAL_PENDING 013_drop.sql — drops customer columns",
    );
    expect(manualPendingLine("013_drop.sql", "")).toBe("[MIGRATIONS] MANUAL_PENDING 013_drop.sql");
    expect(statusPendingLine(["041_a.sql", "042_b.sql"])).toBe(
      "[MIGRATIONS] Status: PENDING 2: 041_a.sql, 042_b.sql",
    );
  });

  it("survives the shell expansion the workflows use to cut the prefix", () => {
    const line = manualPendingLine("013_drop.sql", "drops customer columns");
    const cut = (pattern: string) =>
      execFileSync("bash", ["-c", `LINE="$1"; printf '%s' "\${LINE#${pattern}}"`, "_", line], {
        encoding: "utf8",
      });
    expect(cut("*MANUAL_PENDING ")).toBe("013_drop.sql — drops customer columns");
    // `[MIGRATIONS]` is a one-character set in bash. It cut nothing from the retired line…
    expect(cut("*[MIGRATIONS] ").length).toBeGreaterThan(0);
    const retired = "[MIGRATIONS] ⏸ Holding 013_drop.sql (manual — needs `bun migrate --manual`).";
    expect(
      execFileSync(
        "bash",
        ["-c", 'LINE="$1"; printf "%s" "${LINE#*[MIGRATIONS] }"', "_", retired],
        {
          encoding: "utf8",
        },
      ),
    ).toBe(retired);
    // …and on this one it only works because PENDING ends in a capital from the set.
    expect(cut("*[MIGRATIONS] ")).toBe("013_drop.sql — drops customer columns");
  });
});
