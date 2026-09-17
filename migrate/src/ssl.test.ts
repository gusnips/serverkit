import { describe, expect, it } from "vitest";
import { pgSsl } from "./ssl.ts";

describe("pgSsl", () => {
  it("leaves ssl unset when the URL has an sslmode, so pg reads the URL", () => {
    for (const mode of ["disable", "require", "verify-full"])
      expect(pgSsl(`postgresql://u:p@db.example.com:5432/app?sslmode=${mode}`)).toEqual({});
    expect(pgSsl("postgresql://u:p@db.abc.supabase.co:5432/postgres?sslmode=verify-full")).toEqual(
      {},
    );
  });

  it("connects to Supabase cloud with TLS and no certificate check", () => {
    for (const host of [
      "db.abcdef.supabase.co",
      "aws-0-sa-east-1.pooler.supabase.com",
      "DB.X.SUPABASE.CO",
    ])
      expect(pgSsl(`postgresql://u:p@${host}:5432/postgres`)).toEqual({
        ssl: { rejectUnauthorized: false },
      });
  });

  it("turns TLS off everywhere else, overriding PGSSLMODE", () => {
    for (const host of ["127.0.0.1", "localhost", "db", "db.example.com", "supabase.co.evil.com"])
      expect(pgSsl(`postgresql://u:p@${host}:5432/app`)).toEqual({ ssl: false });
  });

  it("infers nothing from nothing", () => {
    expect(pgSsl(undefined)).toEqual({});
    expect(pgSsl("")).toEqual({});
    expect(pgSsl("not a url")).toEqual({});
  });
});
