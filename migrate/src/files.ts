import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readDirectives, type Directives } from "./directives.ts";
import { splitSqlStatements } from "./split.ts";

export interface MigrationFile extends Directives {
  /** The file name, e.g. `012_add_orders.sql`. */
  file: string;
  /** The name without `.sql`. It is what the tracking table stores. */
  version: string;
  sql: string;
  /** The statements of a `no-transaction` file, split before anything connects. */
  statements: string[];
}

/** The `.sql` files of a listing, in apply order: numeric-aware, so `2_x.sql` sorts before `10_x.sql`. */
export function sortMigrationFiles(files: readonly string[]): string[] {
  return files
    .filter((file) => file.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/**
 * Read every migration in `dir`, with its directives, before a connection opens.
 *
 * A missing folder is an error, not "nothing to apply". The path comes from the adopter, and a
 * typo that reads as an empty folder is a deploy that silently applies nothing. A bad directive
 * or an unsplittable file fails here too, so it stops the run before the first file applies
 * rather than halfway through.
 *
 * The version is the whole file name, so two files that share a number (`004_a.sql`,
 * `004_b.sql`) are two versions. Repos already have those, and they are safe.
 */
export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT")
      throw new Error(`No migrations folder at ${dir}. Check the dir the runner was given.`, {
        cause: err,
      });
    throw err;
  }

  const files: MigrationFile[] = [];
  for (const file of sortMigrationFiles(names)) {
    const sql = await readFile(join(dir, file), "utf8");
    const directives = readDirectives(file, sql);
    let statements: string[] = [];
    if (directives.noTransaction) {
      try {
        statements = splitSqlStatements(sql);
      } catch (err) {
        throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
    }
    files.push({ file, version: file.replace(/\.sql$/, ""), sql, statements, ...directives });
  }
  return files;
}
