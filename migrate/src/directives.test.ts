import { describe, expect, it } from "vitest";
import { readDirectives } from "./directives.ts";

describe("readDirectives", () => {
  it("reads both directives from the leading comment block", () => {
    expect(
      readDirectives(
        "201_index.sql",
        "-- migrate: manual\n-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY a ON t (x);",
      ),
    ).toEqual({ manual: true, reason: "", noTransaction: true });
  });

  it("keeps a reason and treats the two directives as independent", () => {
    expect(
      readDirectives(
        "013_drop.sql",
        "-- 013_drop.sql\n-- migrate: manual — drops customer columns\n\nALTER TABLE t DROP COLUMN x;",
      ),
    ).toEqual({ manual: true, reason: "drops customer columns", noTransaction: false });
    expect(readDirectives("a.sql", "-- migrate: manual: waits for a drain\nSELECT 1;").reason).toBe(
      "waits for a drain",
    );
    expect(readDirectives("a.sql", "-- migrate: no-transaction\nVACUUM t;")).toEqual({
      manual: false,
      reason: "",
      noTransaction: true,
    });
  });

  it("reads nothing into a plain file", () => {
    expect(readDirectives("a.sql", "-- adds orders\nCREATE TABLE t (x int);")).toEqual({
      manual: false,
      reason: "",
      noTransaction: false,
    });
  });

  it("does not let a comment below the first statement flip the file", () => {
    // Prose that mentions the marker is not the marker.
    expect(
      readDirectives("a.sql", "CREATE TABLE t (x int);\n-- see 190, which uses migrate: manual\n")
        .manual,
    ).toBe(false);
  });

  it("refuses a directive after the first statement, where it would be ignored", () => {
    expect(() =>
      readDirectives("a.sql", "CREATE TABLE t (x int);\n-- migrate: manual\nDROP TABLE u;"),
    ).toThrow(/a\.sql, line 2: .*after the first SQL statement/);
  });

  it("refuses an unknown directive", () => {
    expect(() => readDirectives("a.sql", "-- migrate: manuel\nSELECT 1;")).toThrow(
      /unknown directive "-- migrate: manuel"/,
    );
    expect(() => readDirectives("a.sql", "-- MIGRATE: MANUAL\nSELECT 1;")).toThrow(/unknown/);
  });

  it("refuses the old @manual marker, whose meaning differed between runners", () => {
    expect(() =>
      readDirectives("013_drop.sql", "-- @manual: drops columns\nALTER TABLE t;"),
    ).toThrow(/"-- @manual" is no longer read.*"-- migrate: manual".*"-- migrate: no-transaction"/);
    // Only as a marker line; the word inside a sentence is prose.
    expect(readDirectives("a.sql", "-- marked @manual in the old runner\nSELECT 1;").manual).toBe(
      false,
    );
  });

  it("ignores a byte order mark", () => {
    expect(readDirectives("a.sql", "\uFEFF-- migrate: manual\nSELECT 1;").manual).toBe(true);
  });
});
