import { describe, expect, it } from "vitest";
import { splitSqlStatements } from "./split.ts";

describe("splitSqlStatements", () => {
  it("splits on semicolons that end statements", () => {
    expect(
      splitSqlStatements(
        "CREATE INDEX CONCURRENTLY a ON t (x);\nCREATE INDEX CONCURRENTLY b ON t (y);\n",
      ),
    ).toEqual(["CREATE INDEX CONCURRENTLY a ON t (x);", "CREATE INDEX CONCURRENTLY b ON t (y);"]);
  });

  it("keeps semicolons inside strings, quoted names, comments and dollar quotes", () => {
    const sql = [
      "-- a comment; with a semicolon",
      "SELECT 'a;b', \"we;ird\";",
      "/* block; comment */ SELECT 1;",
      "DO $$ BEGIN PERFORM 1; END $$;",
      "DO $body$ BEGIN PERFORM ';'; END $body$;",
    ].join("\n");
    expect(splitSqlStatements(sql)).toHaveLength(4);
  });

  it("reads doubled quotes as one quote", () => {
    expect(splitSqlStatements("SELECT 'it''s; fine'; SELECT 2;")).toEqual([
      "SELECT 'it''s; fine';",
      "SELECT 2;",
    ]);
  });

  it("nests block comments, as Postgres does", () => {
    expect(
      splitSqlStatements("/* outer /* inner; */ still; comment */ SELECT 1; SELECT 2;"),
    ).toEqual(["/* outer /* inner; */ still; comment */ SELECT 1;", "SELECT 2;"]);
  });

  it("honours backslash escapes in E'' strings only", () => {
    expect(splitSqlStatements("SELECT E'it\\'s; fine'; SELECT 2;")).toEqual([
      "SELECT E'it\\'s; fine';",
      "SELECT 2;",
    ]);
    // In a standard string a backslash is just a character, so the quote after it closes.
    expect(splitSqlStatements("SELECT 'C:\\'; SELECT 2;")).toEqual(["SELECT 'C:\\';", "SELECT 2;"]);
  });

  it("does not open a dollar quote on a $ inside an identifier", () => {
    expect(splitSqlStatements("SELECT price$usd$ FROM t; SELECT 2;")).toEqual([
      "SELECT price$usd$ FROM t;",
      "SELECT 2;",
    ]);
  });

  it("drops a trailing piece that is only comments", () => {
    expect(splitSqlStatements("SELECT 1;\n-- done\n")).toEqual(["SELECT 1;"]);
  });

  it("refuses a BEGIN ATOMIC body instead of splitting it wrongly", () => {
    const sql =
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END;";
    expect(() => splitSqlStatements(sql)).toThrow(/BEGIN ATOMIC/);
    // A transaction's BEGIN is not a function body.
    expect(splitSqlStatements("BEGIN; SELECT 1; COMMIT;")).toHaveLength(3);
  });
});
