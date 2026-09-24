/**
 * Copying the API's own type declarations into its SDK, with their comments.
 *
 * A published SDK cannot depend on the API's workspace, so the types it answers with have to
 * travel inside it. A `.d.ts` emit would carry the types and drop the prose, and the prose is most
 * of what makes an SDK pleasant to hold, so this reads each declaration as it is written at home
 * and copies it whole. Five generators did this with one hand-written reader, and each copy had
 * fixed something the others had not:
 * - a property KEY is not a reference (`VALIDATION_ERROR: 400` names no type);
 * - an `export function` is a braced block, like an interface;
 * - `(typeof X)[number]` can be written as its literal union, where the array would be dead.
 * And all five broke what the reader rests on, that the blanked text matches the original line for
 * line: an escaped newline in a string moved every later line, a backslash at the end of a `//`
 * comment blanked the next line, a `/*` followed by `/` closed on its own star, and a one-line
 * `{}` block ran on into the next declaration.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILTIN } from "./types.ts";

export interface LiftOptions {
  /** The directory `sources` are relative to, usually the repo root. */
  root: string;
  /** The files a public type may come from. They are written out in this order. */
  sources: readonly string[];
  /** The names the SDK needs. Everything they mention comes along. */
  roots: readonly string[];
  /**
   * Write `(typeof X)[number]` as its literal union, and leave the array out. Off by default: an SDK
   * that re-exports its contract publishes that array, so dropping it is a breaking change, and
   * each member's doc comment goes with it.
   */
  inlineTuples?: boolean;
  /**
   * Keep `export` on the roots only. What they mention is still written, without it, so the SDK's
   * public names are exactly the ones listed. Off by default: everything written is exported.
   */
  exportOnlyRoots?: boolean;
}

interface Block {
  name: string;
  /** The declaration with its doc comment, as it reads at home. */
  source: string;
  /** The names it mentions, followed so nothing lands half-defined. */
  refs: string[];
}

/**
 * The source with every comment and string body blanked, one character for one character and a
 * newline for a newline, so structure can be read off it while the ORIGINAL lines are what gets
 * copied. Without it a `;` inside a sentence ends a declaration early, and every capitalized word
 * in the prose looks like a type. `keepStrings` blanks the comments only, for reading the strings
 * themselves: an apostrophe in a comment is not a quote.
 *
 * ponytail: a regex literal is read as code, so a quote inside one (`/"/`) opens a string that
 * runs to the next quote. Contract files are declarations, where that does not come up; one that
 * needs it would need a real tokenizer here.
 */
export function blankCommentsAndStrings(source: string, { keepStrings = false } = {}): string {
  let out = "";
  let state: "code" | "line" | "block" | '"' | "'" | "`" = "code";
  const blank = (c: string | undefined) => (c === "\n" ? "\n" : c === undefined ? "" : " ");
  const inString = (c: string | undefined) => (keepStrings ? (c ?? "") : blank(c));
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? "";
    const next = source[i + 1];
    if (state === "code") {
      if (c === "/" && (next === "/" || next === "*")) {
        // Both characters of the opener, so the `*` of `/*/` cannot also close it.
        state = next === "/" ? "line" : "block";
        out += "  ";
        i++;
      } else if (c === '"' || c === "'" || c === "`") {
        state = c;
        out += inString(c);
      } else out += c;
      continue;
    }
    if (state === "line" || state === "block") {
      if (state === "block" && c === "*" && next === "/") {
        state = "code";
        out += "  ";
        i++;
        continue;
      }
      if (c === "\n" && state === "line") state = "code";
      out += blank(c);
      continue;
    }
    if (c === "\\") {
      // An escape never closes a string, and the character it escapes may be a newline.
      out += inString(c) + inString(next);
      i++;
      continue;
    }
    if (c === state) state = "code";
    out += inString(c);
  }
  return out;
}

/** Split one file into its exported top-level declarations. */
function readBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const clean = blankCommentsAndStrings(text).split("\n");
  const blocks: Block[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = /^export (interface|type|const|function) (\w+)/.exec(clean[i] ?? "");
    if (!match?.[2]) continue;
    const name = match[2];

    // Back over the doc comment sitting on top of the declaration.
    let start = i;
    while (start > 0) {
      const above = (lines[start - 1] ?? "").trim();
      if (!above || (!above.startsWith("*") && !above.startsWith("/*"))) break;
      start--;
    }

    // Forward to its end: the first `;` outside every bracket, since a mapped type carries one on
    // an inner line, or for an interface or a function, the line that closes its brackets. That
    // can be its first (`export interface Empty {}`); waiting for a lone `}`, as every copy did,
    // swallowed the declaration after it.
    const braced = match[1] === "interface" || match[1] === "function";
    let end = i;
    let depth = 0;
    outer: for (; end < lines.length; end++) {
      for (const char of clean[end] ?? "") {
        if ("{[(".includes(char)) depth++;
        else if ("}])".includes(char)) depth--;
        else if (char === ";" && depth === 0) break outer;
      }
      if (braced && depth === 0) break;
    }

    const body = clean
      .slice(i, end + 1)
      .join("\n")
      // A property KEY is not a reference: `VALIDATION_ERROR: 400` names a member, not a type.
      .replace(/\b[A-Z][A-Za-z0-9_]*(?=\s*\??:)/g, " ");
    const refs = [...new Set(body.match(/\b[A-Z][A-Za-z0-9_]*\b/g) ?? [])].filter(
      // ponytail: a short name is taken for a type parameter (`T`, `K`). A wrong guess is loud,
      // not silent: a skipped name that WAS needed leaves the SDK missing a type, and it stops
      // compiling.
      (ref) => ref !== name && ref.length > 2 && !BUILTIN.has(ref),
    );
    blocks.push({ name, source: lines.slice(start, end + 1).join("\n"), refs });
    i = end;
  }
  return blocks;
}

/**
 * With `inlineTuples`, `export type Plan = (typeof PLANS)[number];` becomes
 * `export type Plan = "free" | "pro";`, and the array is left out. Only a tuple of plain string
 * literals qualifies; anything else throws, because guessing a union into a published type is
 * worse than stopping.
 */
function inlineTupleUnions(index: Map<string, Block>): void {
  for (const block of index.values()) {
    const alias = /export type (\w+) = \(?typeof (\w+)\)?\[number\];/.exec(block.source);
    if (!alias?.[2]) continue;
    const tuple = index.get(alias[2]);
    if (tuple === undefined) continue; // reported as missing below
    // Comments out first, strings kept: a member's doc comment can hold an apostrophe.
    const code = blankCommentsAndStrings(tuple.source, { keepStrings: true });
    const literal = /=\s*\[([\s\S]*?)\]\s*as const\s*;/.exec(code);
    const members = literal?.[1]?.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) ?? [];
    const rest = literal?.[1]?.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "");
    if (literal === null || rest === undefined || /[^\s,]/.test(rest)) {
      throw new Error(
        `${alias[2]} must be a tuple of string literals \`as const\` for ${block.name} to be written as a union.`,
      );
    }
    const union = members.map((member) => {
      let unreadable = false;
      const text = member.slice(1, -1).replace(/\\([\s\S])/g, (_escape, char: string) => {
        unreadable ||= !`"'\\`.includes(char);
        return char;
      });
      // ponytail: only a quote or a backslash is unescaped. Any other escape (`\n`, `\u00e9`)
      // needs the language's whole table, so it stops rather than write a wrong member.
      if (unreadable) {
        throw new Error(
          `${alias[2]} has a member with an escape this cannot read: ${member}. Write it without one, or leave inlineTuples off.`,
        );
      }
      return JSON.stringify(text);
    });
    block.source = block.source.replace(
      alias[0],
      `export type ${block.name} = ${union.join(" | ") || "never"};`,
    );
    block.refs = [];
  }
}

/**
 * Every declaration the roots need, in source order, as one file's text. A name nobody declares
 * throws with the list of files searched: a contract with a dangling reference does not compile,
 * and finding out here beats finding out at publish.
 */
export function liftContract({
  root,
  sources,
  roots,
  inlineTuples = false,
  exportOnlyRoots = false,
}: LiftOptions): string {
  const files = sources.map((file) => ({
    file,
    blocks: readBlocks(readFileSync(join(root, file), "utf8")),
  }));
  const index = new Map<string, Block>();
  for (const { blocks } of files) for (const block of blocks) index.set(block.name, block);
  if (inlineTuples) inlineTupleUnions(index);

  const needed = new Set<string>();
  const missing = new Set<string>();
  const visit = (name: string): void => {
    if (needed.has(name)) return;
    const block = index.get(name);
    if (block === undefined) {
      missing.add(name);
      return;
    }
    needed.add(name);
    block.refs.forEach(visit);
  };
  roots.forEach(visit);
  if (missing.size > 0) {
    throw new Error(
      `No declaration found for ${[...missing].join(", ")}. Export it from one of:\n  ${sources.join("\n  ")}`,
    );
  }

  const chunks: string[] = [];
  for (const { file, blocks } of files) {
    const wanted = blocks.filter((b) => needed.has(b.name));
    if (wanted.length === 0) continue;
    chunks.push(`// ── from ${file} ${"─".repeat(Math.max(0, 60 - file.length))}\n`);
    const text = (b: Block) =>
      exportOnlyRoots && !roots.includes(b.name) ? b.source.replace(/^export /m, "") : b.source;
    chunks.push(wanted.map(text).join("\n\n"));
  }
  return chunks.join("\n");
}
