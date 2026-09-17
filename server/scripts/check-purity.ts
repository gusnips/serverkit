#!/usr/bin/env bun
/**
 * Platform-purity check for `@gusnips/server`.
 *
 * Adapted from the frontend kit's, which exists because **tsc cannot promise this**: a
 * root-level `@types/node` is visible to every workspace, so a stray `import { randomBytes }
 * from "node:crypto"` typechecks fine and then fails to import inside a Cloudflare Worker.
 * Only reading the source catches it.
 *
 * The rule IS the package's boundary, restated as a test. `.` and `/hono` must import cleanly
 * in a Worker, so neither may reach for `node:*`, for `process`, or for `Buffer`. `src/node/`
 * is the one directory that may — and having somewhere for the crash handlers and the shutdown
 * timer to live is exactly what lets the rest be strict.
 *
 * The sibling rule is the one this file cannot check and no grep ever will: **a sync Web Crypto
 * call.** `crypto.subtle` is async-only in Workers, so `hashCredential`, `verifyHmac` and `seal`
 * return promises or no Worker can ever adopt this package. One backend already on that
 * runtime carries the proof in its own comment —
 * "the sync `constructEvent()` throws before checking the signature". That one is checked by eye
 * at every extraction, and by the types.
 *
 * Run: bun run purity
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const NODE_PATTERN =
  /(?:from\s+['"]|import\s*\(\s*['"]|require\s*\(\s*['"])(?:node:)?(?:fs|path|os|child_process|crypto|net|http|https|stream|buffer|worker_threads|cluster|dns|tls|dgram|readline|vm|zlib|util|url|querystring|assert|events|process|perf_hooks|timers)(?:\/[^'"]*)?['"]|(?:^|[^.\w$])(?:process\.(?:env|on|exit|cwd|hrtime)|Buffer|__dirname|__filename)\b/;

/** `src/node/` is the exception. Tests are skipped: they run under Node by definition. */
const EXEMPT = /(?:^|\/)(?:node\/|__tests__\/|[^/]+\.test\.ts$)/;

interface Violation {
  file: string;
  line: number;
  content: string;
}

async function collectTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectTsFiles(full)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

async function main(): Promise<void> {
  const src = join(import.meta.dirname, "..", "src");
  const files = (await collectTsFiles(src).catch(() => [])).filter(
    (f) => !EXEMPT.test(relative(src, f)),
  );

  const violations: Violation[] = [];
  for (const file of files) {
    const lines = stripComments(await readFile(file, "utf-8")).split("\n");
    for (const [i, line] of lines.entries()) {
      if (NODE_PATTERN.test(line))
        violations.push({ file: relative(src, file), line: i + 1, content: line.trim() });
    }
  }

  if (violations.length === 0) {
    console.log(`✓ purity: ${files.length} files, no Node leaks outside src/node/.`);
    return;
  }

  console.error("✗ purity FAILED — a Worker could not import this.\n");
  for (const v of violations) {
    console.error(`    ${v.file}:${v.line}`);
    console.error(`      ${v.content}`);
  }
  console.error("\n  Move it to src/node/, or use the Web-standard equivalent.");
  process.exit(1);
}

await main();
