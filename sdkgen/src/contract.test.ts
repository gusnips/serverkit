import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { blankCommentsAndStrings, liftContract } from "./contract.ts";

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "sdkgen-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

const HTTP = `import { z } from "zod";

/** Every code the API answers with. */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * A refusal.
 * The message is for a log; the code is for a program.
 */
export interface ApiError {
  code: ErrorCode;
  message: string;
}

const internal = 1;
`;

const DTO = `/** One message; see Status. */
export interface MessageDto {
  id: string;
  /** Where it is; "Sent" means the server took it; not a type. */
  status: MessageStatus;
  sentAt: Date | null;
}

export const STATUSES = [
  /** It's waiting; nothing has gone out. */
  "queued",
  "sent",
  "failed",
] as const;

export type MessageStatus = (typeof STATUSES)[number];

export type Page<T> = { items: T[]; next: string | null };

export type ByStatus = { [K in MessageStatus]: number; };

export function isSent(message: MessageDto): boolean {
  return message.status === "sent";
}
`;

describe("liftContract", () => {
  const root = repo({ "http.ts": HTTP, "dto.ts": DTO });
  const lift = (roots: string[], inlineTuples = false) =>
    liftContract({ root, sources: ["http.ts", "dto.ts"], roots, inlineTuples });

  it("copies a declaration with its comment, and what it mentions, in source order", () => {
    const out = lift(["ApiError"]);
    expect(out).toContain("/** Every code the API answers with. */\nexport const ERROR_STATUS");
    expect(out).toContain("export type ErrorCode = keyof typeof ERROR_STATUS;");
    expect(out).toContain(
      " * A refusal.\n * The message is for a log; the code is for a program.\n */",
    );
    expect(out.indexOf("ERROR_STATUS =")).toBeLessThan(out.indexOf("interface ApiError"));
    expect(out).not.toContain("internal");
    expect(out).not.toContain("MessageDto");
  });

  it("does not read a property key as a type to find", () => {
    // VALIDATION_ERROR and NOT_FOUND are keys of ERROR_STATUS; declared nowhere, they would throw.
    expect(() => lift(["ERROR_STATUS"])).not.toThrow();
  });

  it("copies a tuple as it is written, its members' comments included", () => {
    const out = lift(["MessageDto"]);
    expect(out).toContain(
      "export const STATUSES = [\n  /** It's waiting; nothing has gone out. */",
    );
    expect(out).toContain("export type MessageStatus = (typeof STATUSES)[number];");
  });

  it("can write a tuple's element type as its literal union, and leave the array behind", () => {
    // The apostrophe in the member's comment is not a quote.
    const out = lift(["MessageDto"], true);
    expect(out).toContain('export type MessageStatus = "queued" | "sent" | "failed";');
    expect(out).not.toContain("STATUSES");
  });

  it("ignores words in comments and strings, and a semicolon inside a mapped type", () => {
    // "Status" and "Sent" in the prose are not types; the mapped type's `;` is inside braces.
    const out = lift(["MessageDto", "ByStatus"]);
    expect(out).toContain("export type ByStatus = { [K in MessageStatus]: number; };");
  });

  it("can keep export on the roots only", () => {
    const out = lift(["ApiError"]).replace(/\n+/g, "\n");
    expect(out).toContain("export const ERROR_STATUS");
    const quiet = liftContract({
      root,
      sources: ["http.ts", "dto.ts"],
      roots: ["ApiError"],
      exportOnlyRoots: true,
    });
    expect(quiet).toContain("/** Every code the API answers with. */\nconst ERROR_STATUS = {");
    expect(quiet).toContain("\ntype ErrorCode = keyof typeof ERROR_STATUS;");
    expect(quiet).toContain("\nexport interface ApiError {");
  });

  it("copies an exported function whole", () => {
    expect(lift(["isSent"])).toContain('  return message.status === "sent";\n}');
  });

  it("names what it could not find, and where it looked", () => {
    expect(() => lift(["Missing"])).toThrow(
      /No declaration found for Missing\. Export it from one of:\n {2}http\.ts\n {2}dto\.ts/,
    );
  });

  it("unescapes a quoted member before writing it", () => {
    const quoted = repo({
      "a.ts": `export const KINDS = ["a", 'b\\'c'] as const;\n\nexport type Kind = (typeof KINDS)[number];\n`,
    });
    expect(
      liftContract({ root: quoted, sources: ["a.ts"], roots: ["Kind"], inlineTuples: true }),
    ).toContain(`export type Kind = "a" | "b'c";`);
  });

  it("refuses a member escape it cannot read, rather than writing a wrong member", () => {
    const escaped = repo({
      "a.ts": `export const KINDS = ["a\\nb"] as const;\n\nexport type Kind = (typeof KINDS)[number];\n`,
    });
    expect(() =>
      liftContract({ root: escaped, sources: ["a.ts"], roots: ["Kind"], inlineTuples: true }),
    ).toThrow(/KINDS has a member with an escape this cannot read: "a\\nb"/);
  });

  it("refuses a tuple it cannot read as string literals", () => {
    const odd = repo({
      "a.ts": `export const SIZES = [1, 2] as const;\n\nexport type Size = (typeof SIZES)[number];\n`,
    });
    expect(() =>
      liftContract({ root: odd, sources: ["a.ts"], roots: ["Size"], inlineTuples: true }),
    ).toThrow(/SIZES must be a tuple of string literals/);
  });

  it("keeps every later declaration in place after an escaped newline", () => {
    const tricky = repo({
      "a.ts": [
        'export const HELP = "one \\',
        'two";',
        "",
        "/** The plan. */",
        "export interface Plan {",
        "  id: string;",
        "}",
        "",
      ].join("\n"),
    });
    expect(liftContract({ root: tricky, sources: ["a.ts"], roots: ["Plan"] })).toContain(
      "/** The plan. */\nexport interface Plan {\n  id: string;\n}",
    );
  });
  it("ends a one-line interface on its own line", () => {
    const flat = repo({
      "a.ts": "export interface Empty {}\n\nexport interface Plan {\n  id: string;\n}\n",
    });
    const out = liftContract({ root: flat, sources: ["a.ts"], roots: ["Empty"] });
    expect(out).toContain("export interface Empty {}");
    expect(out).not.toContain("Plan");
  });
});

describe("blankCommentsAndStrings", () => {
  it("keeps every line and every column", () => {
    const source = 'const a = "x;\\"y"; // Type\n/* Also\n a Type */ const b = `t\\\nu`;\n';
    const clean = blankCommentsAndStrings(source);
    expect(clean.length).toBe(source.length);
    expect(clean.split("\n").length).toBe(source.split("\n").length);
    expect(clean).not.toMatch(/Type|x;|y/);
    expect(clean).toContain("const b =");
  });

  it("ends a line comment at its newline, even after a backslash", () => {
    expect(blankCommentsAndStrings("// C:\\\nexport type X = 1;")).toBe(
      "      \nexport type X = 1;",
    );
  });

  it("does not close a comment on the star that opened it", () => {
    expect(blankCommentsAndStrings("/*/ Type */ x")).toBe("            x");
  });
});
