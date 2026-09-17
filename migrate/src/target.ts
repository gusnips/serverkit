/**
 * Which database a URL points at, and whether writing to it needs an explicit `--yes`.
 *
 * The guard exists because a laptop's `.env` often reaches production. Sometimes it names the
 * production host. Sometimes it names `127.0.0.1` on the port an SSH tunnel forwards to the
 * production box, and then a hostname check alone calls production "local". Only two of the
 * runners this replaces checked the port as well, and those two are the version kept here.
 *
 * Seed and smoke scripts import these too, so the rule lives in one place. A second copy of it in
 * each script is how one of them ends up weaker.
 */

export interface Target {
  host: string;
  port: number;
  database: string;
}

export interface GuardOptions {
  /** A loopback port an SSH tunnel forwards to a remote database. Writing there needs `--yes`. */
  tunnelPort?: number;
}

/** Hosts that are this machine. `db` is the usual compose service name inside a container. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "db"]);

/**
 * Host, port and database from a Postgres URL, or null when it will not parse.
 *
 * The brackets come off an IPv6 host: `new URL("postgresql://[::1]/db").hostname` is `"[::1]"`,
 * and one runner compared that against `"::1"` and so treated its own machine as remote.
 */
export function describeTarget(databaseUrl: string): Target | null {
  try {
    const url = new URL(databaseUrl);
    return {
      // `postgresql:///app?host=/var/run/postgresql` is a form pg reads too: no host in the
      // authority, the real one in the query string.
      host: (url.hostname || url.searchParams.get("host") || "").replace(/^\[|\]$/g, ""),
      port: Number(url.port || url.searchParams.get("port")) || 5432,
      database: decodeURIComponent(url.pathname.replace(/^\//, "")) || "postgres",
    };
  } catch {
    return null;
  }
}

/** A loopback name, the compose service, or a Unix socket directory. */
export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.startsWith("/");
}

/** Why writing to this target needs an explicit `--yes`, or null when it does not. */
export function confirmationReason(target: Target, options: GuardOptions = {}): string | null {
  if (!isLocalHost(target.host)) return `remote host "${target.host}"`;
  if (options.tunnelPort !== undefined && target.port === options.tunnelPort)
    return `the SSH tunnel on port ${String(options.tunnelPort)}`;
  return null;
}

/**
 * Stop a script that writes rows unless DATABASE_URL is a local database.
 *
 * For seed and smoke scripts, which have no `--yes` on purpose: the migration runner asks, these
 * simply refuse. It exits the process, because that is the whole contract, and it prints why.
 */
export function requireLocalDatabase(
  tag: string,
  databaseUrl: string | undefined,
  options: GuardOptions = {},
): void {
  if (!databaseUrl) {
    console.error(`[${tag}] DATABASE_URL is not set. Point it at a throwaway local database.`);
    process.exit(1);
  }
  const target = describeTarget(databaseUrl);
  const reason = target ? confirmationReason(target, options) : "a URL that does not parse";
  if (reason) {
    console.error(`[${tag}] Refusing to run against ${reason}: this script writes rows.`);
    console.error(`[${tag}] Point DATABASE_URL at a throwaway local database.`);
    process.exit(1);
  }
}
