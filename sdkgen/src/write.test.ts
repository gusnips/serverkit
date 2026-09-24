import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeGenerated } from "./write.ts";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "sdkgen-write-"));
  // The repo's own style, which the output must follow rather than prettier's defaults.
  writeFileSync(join(root, ".prettierrc"), JSON.stringify({ tabWidth: 4 }));
  return root;
}

const UGLY = "export interface A {\na: string\n}\n";
const PRETTY = "export interface A {\n    a: string;\n}\n";

describe("writeGenerated", () => {
  it("writes each file through the repo's prettier config, creating its folder", async () => {
    const root = repo();
    const path = join(root, "src/generated/a.ts");
    expect(await writeGenerated({ [path]: UGLY })).toEqual({ written: [path], stale: [] });
    expect(readFileSync(path, "utf8")).toBe(PRETTY);
  });

  it("reads a relative path from root, and reports it as given", async () => {
    const root = repo();
    const name = "src/generated/a.ts";
    expect(await writeGenerated({ [name]: UGLY }, { root, check: true })).toEqual({
      written: [],
      stale: [name],
    });
    expect(await writeGenerated({ [name]: UGLY }, { root })).toEqual({
      written: [name],
      stale: [],
    });
    expect(readFileSync(join(root, name), "utf8")).toBe(PRETTY);
  });

  it("leaves a current file alone", async () => {
    const root = repo();
    const path = join(root, "a.ts");
    writeFileSync(path, PRETTY);
    expect(await writeGenerated({ [path]: UGLY })).toEqual({ written: [], stale: [] });
    expect(await writeGenerated({ [path]: UGLY }, { check: true })).toEqual({
      written: [],
      stale: [],
    });
  });

  it("when checking, lists a missing or different file and writes nothing", async () => {
    const root = repo();
    const changed = join(root, "a.ts");
    const missing = join(root, "b.ts");
    writeFileSync(changed, "export {};\n");
    expect(await writeGenerated({ [changed]: UGLY, [missing]: UGLY }, { check: true })).toEqual({
      written: [],
      stale: [changed, missing],
    });
    expect(readFileSync(changed, "utf8")).toBe("export {};\n");
  });

  it("fails on a file it cannot read, rather than calling it stale", async () => {
    const folder = join(repo(), "a.ts");
    mkdirSync(folder);
    await expect(writeGenerated({ [folder]: UGLY }, { check: true })).rejects.toThrow(/EISDIR/);
  });
});
