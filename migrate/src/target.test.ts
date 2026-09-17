import { describe, expect, it } from "vitest";
import { confirmationReason, describeTarget } from "./target.ts";

describe("describeTarget", () => {
  it("reads host, port and database", () => {
    expect(describeTarget("postgresql://u:p@127.0.0.1:5433/postgres")).toEqual({
      host: "127.0.0.1",
      port: 5433,
      database: "postgres",
    });
    expect(describeTarget("postgresql://u:p@db.example.com/")).toEqual({
      host: "db.example.com",
      port: 5432,
      database: "postgres",
    });
    expect(describeTarget("not a url")).toBeNull();
  });

  it("reads a host and port given in the query string", () => {
    expect(describeTarget("postgresql:///app?host=127.0.0.1&port=6543")).toEqual({
      host: "127.0.0.1",
      port: 6543,
      database: "app",
    });
    expect(describeTarget("postgresql:///app?host=/var/run/postgresql")?.host).toBe(
      "/var/run/postgresql",
    );
  });

  it("strips the brackets from an IPv6 host", () => {
    // `new URL(...).hostname` is "[::1]"; compared as-is, this machine reads as remote.
    expect(describeTarget("postgresql://u:p@[::1]:5432/app")?.host).toBe("::1");
  });
});

describe("confirmationReason", () => {
  const at = (url: string, tunnelPort?: number) => {
    const target = describeTarget(url);
    if (!target) throw new Error(`test URL did not parse: ${url}`);
    return confirmationReason(target, { tunnelPort });
  };

  it("lets this machine, a compose service and CI through", () => {
    for (const url of [
      "postgresql://p@127.0.0.1:5432/postgres",
      "postgresql://p@localhost:54321/postgres",
      "postgresql://p@[::1]:5432/postgres",
      "postgresql://p@db:5432/postgres",
      "postgresql:///postgres?host=/var/run/postgresql",
    ])
      expect(at(url, 5434)).toBeNull();
  });

  it("asks about a remote host, and about the tunnel port even on loopback", () => {
    expect(at("postgresql://p@db.example.com:5432/app")).toBe('remote host "db.example.com"');
    expect(at("postgresql://p@127.0.0.1:5434/app", 5434)).toBe("the SSH tunnel on port 5434");
    expect(at("postgresql://p@127.0.0.1:5434/app")).toBeNull();
  });
});
