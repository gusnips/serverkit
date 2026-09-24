/**
 * Writing generated files, or proving the ones on disk are current.
 *
 * Every file goes through the repo's own prettier config first. The output is checked in and read
 * by whoever opens the SDK, and formatting it here is also what keeps `format:check` and the
 * generator's own check from ever disagreeing about one file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { format, resolveConfig } from "prettier";

/** The generated text for each file, by path: absolute, or relative to `root`. */
export type GeneratedFiles = Readonly<Record<string, string>>;

export interface WriteOptions {
  /** What a relative path in `files` starts from, usually the repo root. Default: the working directory. */
  root?: string;
  /** Write nothing, and list the files that would change. */
  check?: boolean;
}

/** Paths as `files` spells them, so a message can print them as they are. */
export interface WriteResult {
  /** Files that were missing or different and were written. Always empty when checking. */
  written: string[];
  /** Files that are missing or differ from what the API says today. Always empty when writing. */
  stale: string[];
}

/**
 * Formats each file with the prettier config that applies at its path, then writes it — or, with
 * `check`, writes nothing and lists the files that would change.
 *
 * ```ts
 * const { stale } = await writeGenerated(files, { root, check: process.argv.includes("--check") });
 * if (stale.length > 0) {
 *   console.error(`Out of date:\n  ${stale.join("\n  ")}\nRun \`bun run sdk:gen\` and commit.`);
 *   process.exitCode = 1;
 * }
 * ```
 */
export async function writeGenerated(
  files: GeneratedFiles,
  { root = ".", check = false }: WriteOptions = {},
): Promise<WriteResult> {
  const result: WriteResult = { written: [], stale: [] };
  for (const [name, text] of Object.entries(files)) {
    const path = resolve(root, name);
    const formatted = await format(text, { ...(await resolveConfig(path)), filepath: path });
    if (readOrNull(path) === formatted) continue;
    if (check) {
      result.stale.push(name);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, formatted);
    result.written.push(name);
  }
  return result;
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    // Missing is stale. Anything else, such as a permission error, is not an answer to "is it
    // current", so it throws.
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}
