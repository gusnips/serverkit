import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmationReason, describeTarget, requireLocalDatabase } from "./target.ts";

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

describe("requireLocalDatabase", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Seed and smoke scripts call it first thing and have no --yes, so it must stop the process.
  const exitCode = (url: string | undefined, tunnelPort?: number) => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => errors.push(line));
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    try {
      requireLocalDatabase("SEED", url, { tunnelPort });
      return { code: null, errors };
    } catch (err) {
      return { code: String(err), errors };
    }
  };

  it("lets a local database through", () => {
    expect(exitCode("postgresql://p@127.0.0.1:5432/app", 5434)).toEqual({ code: null, errors: [] });
  });

  it("stops the process for a remote host, the tunnel port, a bad URL or none", () => {
    const remote = exitCode("postgresql://p@db.example.com:5432/app");
    expect(remote.code).toBe("Error: exit 1");
    expect(remote.errors[0]).toBe(
      '[SEED] Refusing to run against remote host "db.example.com": this script writes rows.',
    );
    expect(exitCode("postgresql://p@127.0.0.1:5434/app", 5434).code).toBe("Error: exit 1");
    expect(exitCode("not a url").code).toBe("Error: exit 1");
    expect(exitCode(undefined).errors[0]).toContain("DATABASE_URL is not set");
  });
});
