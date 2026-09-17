/**
 * The `ssl` option for a `pg` Client or Pool, inferred from the connection URL.
 *
 * ```ts
 * new Pool({ connectionString: url, ...pgSsl(url) });
 * ```
 *
 * - **An `sslmode` in the URL wins.** The option is left out, so `pg` reads the URL. (`pg` would
 *   let the URL override the option anyway, but leaving it out keeps the two from ever disagreeing.)
 * - **Supabase cloud** (`*.supabase.co`, `*.pooler.supabase.com`) gets TLS without certificate
 *   verification.
 * - **Every other host gets `ssl: false`.** Self-hosted Postgres behind a loopback pooler, a
 *   compose service and CI all speak plain TCP. The explicit `false` also overrides `PGSSLMODE`.
 *
 * This is the behaviour ten hand-written copies agreed on. Their comments did not agree on WHY
 * Supabase cloud is unverified: half said it "presents valid certs", half said the default CA
 * bundle "can't verify" it, and all of them turned verification off. Nobody measured it, so this
 * keeps what runs today. To verify, put `sslmode=verify-full` (and `sslrootcert=` if needed) in
 * the URL, which this helper then leaves alone.
 */
export function pgSsl(connectionString: string | undefined): {
  ssl?: false | { rejectUnauthorized: false };
} {
  if (!connectionString) return {};
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    // Nothing to infer from. `pg` parses the string itself and reports what is wrong with it.
    return {};
  }
  if (url.searchParams.has("sslmode")) return {};
  const supabaseCloud = /\.supabase\.co$|\.pooler\.supabase\.com$/i.test(url.hostname);
  return { ssl: supabaseCloud ? { rejectUnauthorized: false } : false };
}
