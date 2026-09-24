#!/usr/bin/env bun
/**
 * What the registry will actually receive — checked against the tarball, not the source.
 *
 * Adapted from the frontend kit's check, which exists because two broken releases shipped there
 * with every source file correct: one published the literal range `workspace:*`, and one pinned a
 * sibling to the version a stale lockfile remembered. Neither is visible without unpacking a
 * tarball. Neither package here depends on the other today, so the sibling checks have nothing to
 * catch yet. They run anyway, so a dependency between them cannot arrive without them, plus the
 * ones a package with bins needs:
 *
 * - every `dist` file has a `src` file behind it (tsc never deletes output from a rename);
 * - no dependency range is `workspace:`, and a sibling is pinned to its current version;
 * - every `exports` target and every `bin` is in the tarball, and each bin starts with a shebang;
 * - every bin name starts with `gusnips-`. A bare name like `migrate` belongs to someone else on
 *   npm, so `bunx migrate` in a job without this package installed downloads and runs a stranger's
 *   code with that job's DATABASE_URL, and two generic names collide in an adopter's `.bin`;
 * - every entry of the unpacked tarball imports, and every bin runs, under plain `node` with only
 *   its peers installed. That is the one check that proves no Bun-only global reached the
 *   published code.
 *
 * Run: bun run release:check
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const PACKAGES = ["migrate", "sdkgen", "server"];

/** The commands a bin dispatches to. Each one is run with `--help` from the unpacked tarball. */
const COMMANDS: Record<string, string[]> = {
  "gusnips-migrate": ["db-types", "supabase-stand-in"],
};

interface Manifest {
  name: string;
  version: string;
  exports?: Record<string, string | { types?: string; default?: string }>;
  bin?: Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

const run = (command: string, args: string[], cwd: string) =>
  execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

async function manifestOf(dir: string): Promise<Manifest> {
  return JSON.parse(await readFile(join(ROOT, dir, "package.json"), "utf8")) as Manifest;
}

const current = new Map<string, string>();
for (const dir of PACKAGES) {
  const { name, version } = await manifestOf(dir);
  current.set(name, version);
}

const problems: string[] = [];
const workdir = await mkdtemp(join(tmpdir(), "serverkit-release-"));

try {
  for (const dir of PACKAGES) {
    const cwd = join(ROOT, dir);
    // What `bun publish` runs first: a clean build, and the licence copied in from the root.
    run("bun", ["run", "build"], cwd);
    run("bun", ["run", "sync:docs"], cwd);
    run("bun", ["pm", "pack", "--destination", workdir], cwd);

    const { name, version } = await manifestOf(dir);
    const tarball = join(workdir, `${name.replace("@", "").replace("/", "-")}-${version}.tgz`);
    const entries = run("tar", ["-tzf", tarball], workdir)
      .split("\n")
      .filter(Boolean)
      .map((entry) => entry.replace(/^package\//, ""));
    const packed = JSON.parse(
      run("tar", ["-xzOf", tarball, "package/package.json"], workdir),
    ) as Manifest;
    const has = (path: string) => entries.includes(path.replace(/^\.\//, ""));

    for (const required of ["README.md", "LICENSE", "package.json"])
      if (!has(required)) problems.push(`${name} would publish without ${required}.`);

    const emitted = entries
      .filter((entry) => /^dist\/.+\.(js|d\.ts)(\.map)?$/.test(entry))
      .map((entry) => entry.slice("dist/".length).replace(/\.(js|d\.ts)(\.map)?$/, ""));
    for (const base of new Set(emitted))
      if (!existsSync(join(cwd, "src", `${base}.ts`)))
        problems.push(
          `${name} would publish dist/${base}.* with no src/${base}.ts behind it — stale output ` +
            `from a rename. Run \`bun run build\` (it cleans dist/) and pack again.`,
        );

    for (const [subpath, target] of Object.entries(packed.exports ?? {}))
      for (const path of typeof target === "string" ? [target] : Object.values(target))
        if (path && !has(path))
          problems.push(`${name} exports "${subpath}" as ${path}, which is not in the tarball.`);

    for (const [bin, path] of Object.entries(packed.bin ?? {})) {
      if (!bin.startsWith("gusnips-"))
        problems.push(
          `${name} declares the bin "${bin}". Name it "gusnips-…": with the package not installed, ` +
            `\`bunx ${bin}\` runs whatever npm package owns that name.`,
        );
      if (!has(path)) {
        problems.push(`${name} declares the bin "${bin}" as ${path}, which is not in the tarball.`);
        continue;
      }
      const head = run("tar", ["-xzOf", tarball, `package/${path.replace(/^\.\//, "")}`], workdir);
      if (!head.startsWith("#!/usr/bin/env node\n"))
        problems.push(`${name}'s bin "${bin}" does not start with "#!/usr/bin/env node".`);
    }

    const ranges = { ...packed.dependencies, ...packed.peerDependencies };
    for (const [dep, range] of Object.entries(ranges)) {
      if (range.startsWith("workspace:"))
        problems.push(
          `${name} would publish "${dep}": "${range}" — npm cannot resolve that. ` +
            "Release with `bun publish`, never `npm publish`.",
        );
      const sibling = current.get(dep);
      if (sibling !== undefined && !range.startsWith("workspace:") && range !== sibling)
        problems.push(
          `${name} would pin "${dep}": "${range}", but ${dep} is at ${sibling}. The lockfile is ` +
            "stale: delete bun.lock, run `bun install`, and pack again.",
        );
    }

    // Unpack into a throwaway node_modules, next to the peer it needs and nothing else, and let
    // plain node import it and run every bin.
    const install = join(workdir, `${dir}-install`);
    const target = join(install, "node_modules", name);
    await mkdir(target, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", target, "--strip-components", "1"], workdir);
    for (const peer of Object.keys(packed.peerDependencies ?? {})) {
      const from = join(cwd, "node_modules", peer);
      const to = join(install, "node_modules", peer);
      await mkdir(dirname(to), { recursive: true });
      if (existsSync(from)) await symlink(from, to);
    }
    // Every code entry, not just the root: a subpath is where an optional peer lives, and an import
    // of "." never loads it. A data entry, like an .sql file, is read by its caller, not imported.
    for (const [subpath, target] of Object.entries(packed.exports ?? { ".": "" })) {
      const file = typeof target === "string" ? target : target.default;
      if (file && !file.endsWith(".js")) continue;
      const specifier = name + subpath.slice(1);
      try {
        run(
          "node",
          ["--input-type=module", "-e", `await import(${JSON.stringify(specifier)});`],
          install,
        );
      } catch (err) {
        problems.push(`${specifier} does not import under node: ${String(err)}`);
      }
    }
    for (const [bin, path] of Object.entries(packed.bin ?? {})) {
      for (const command of [[], ...(COMMANDS[bin] ?? []).map((each) => [each])]) {
        try {
          run("node", [join(target, path), ...command, "--help"], install);
        } catch (err) {
          problems.push(
            `${name}'s bin "${[bin, ...command].join(" ")}" does not run under node: ${String(err)}`,
          );
        }
      }
    }

    const pins = Object.entries(ranges)
      .filter(([dep]) => current.has(dep))
      .map(([dep, range]) => `${dep}@${range}`);
    console.log(
      `  ${name}@${version}: ${String(entries.length)} files, ${String(Object.keys(packed.bin ?? {}).length)} bins` +
        `${pins.length ? ` → ${pins.join(", ")}` : ""}`,
    );
  }
} finally {
  await rm(workdir, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n✗ release: ${String(problems.length)} problem(s) in what would be published\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`\n✓ release: ${String(PACKAGES.length)} tarball(s) import and run under node.`);
