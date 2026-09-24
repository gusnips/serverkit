import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

/** The option set seven APIs in the fleet pasted, word for word. */
const API_HEADERS = {
  // Two years, the length the HSTS preload list asks for. Hono's own default is 180 days.
  strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
  xFrameOptions: "DENY",
  // A JSON API loads nothing and is framed by nobody.
  contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
} satisfies SecureHeadersOptions;

/**
 * Hono's `secureHeaders`, set for an API that answers JSON:
 *
 *     app.use(apiSecureHeaders());
 *
 * **Mount it before `errorBoundary`.** It writes its headers after the route has answered, and a
 * throw that is not an `Error` skips that step in every middleware between the throw and the
 * boundary. Mounted inside the boundary, as seven APIs in the fleet had it, the 500 for a
 * plain-object throw goes out with no HSTS, no `nosniff` and no CSP.
 *
 * `overrides` go over the defaults, and CSP directives over the default CSP, so adding a
 * `styleSrc` for one HTML page keeps `default-src 'none'`.
 *
 * Its `Cross-Origin-Resource-Policy: same-origin` does not block your web app: CORP governs a
 * `no-cors` load, such as an `<img>`, and a `fetch` from another origin is a CORS request.
 */
export function apiSecureHeaders(overrides: SecureHeadersOptions = {}): MiddlewareHandler {
  return secureHeaders({
    ...API_HEADERS,
    ...overrides,
    contentSecurityPolicy: {
      ...API_HEADERS.contentSecurityPolicy,
      ...overrides.contentSecurityPolicy,
    },
  });
}

export interface CorsAllowListOptions {
  /**
   * Send `Access-Control-Allow-Credentials`. Off, because a Bearer token is not a credential in
   * CORS's sense. Turn it on only if your client sends `credentials: "include"`: then the browser
   * refuses every answer that does not have it.
   */
  credentials?: boolean;
  /** The request headers a page may send. Left out, a preflight's own list is allowed. */
  allowHeaders?: string[];
  /** Headers a page may read, on top of `Retry-After` and `X-Request-ID`, which are always here. */
  exposeHeaders?: string[];
  allowMethods?: string[];
  /** Seconds a browser may keep a preflight's answer. 600 unless you say otherwise. */
  maxAge?: number;
}

/**
 * CORS for the origins you list and no other, compared exactly:
 *
 *     app.use(corsAllowList(["https://app.example.com", ...env.CORS_EXTRA_ORIGINS]));
 *
 * Each entry is reduced to its origin, so `https://App.example.com/` matches what a browser sends.
 * A blank entry is skipped, for an optional variable left unset. An entry that is not an origin,
 * and an empty list, throw here, at boot. There are no suffix or wildcard rules: one API in the
 * fleet matched origins with `endsWith` and `includes`, which let in any site on `pages.dev` or
 * `web.app`, and its own domain with `.evil.com` added to the end (measured).
 *
 * `.has(origin)` answers the same question, for a door that checks `Origin` itself, such as MCP.
 */
export function corsAllowList(
  origins: Iterable<string>,
  options: CorsAllowListOptions = {},
): MiddlewareHandler & { has(origin: string): boolean } {
  const allowed = new Set<string>();
  for (const entry of origins) if (entry.trim()) allowed.add(originOf(entry.trim()));
  if (allowed.size === 0)
    throw new TypeError(
      "corsAllowList has no origins, so no page in a browser could call this API. Pass the " +
        "origins your apps are served from, or leave CORS out.",
    );
  // Only what the caller gave goes to Hono: an explicit `allowMethods: undefined` would replace
  // Hono's default list, and a preflight would then allow only GET, HEAD and POST.
  const { credentials = false, exposeHeaders = [], maxAge = 600, ...rest } = options;
  const middleware = cors({
    ...rest,
    origin: (origin) => (allowed.has(origin) ? origin : null),
    credentials,
    // A page cannot read a header CORS does not list, and neither of these is on the safe list:
    // without them a client cannot say how long to wait, or quote the id of a failed request.
    exposeHeaders: ["Retry-After", "X-Request-ID", ...exposeHeaders],
    // A browser keeps a preflight for 5 seconds when told nothing, so nearly every call from
    // your app would cost a second round trip.
    maxAge,
  });
  return Object.assign(middleware, { has: (origin: string) => allowed.has(origin) });
}

function originOf(entry: string): string {
  let url: URL | null = null;
  try {
    url = new URL(entry);
  } catch {
    // Reported below, with the same sentence.
  }
  // An entry such as `file:///` has an opaque origin, which is the string "null", and allowing
  // "null" allows every sandboxed iframe and every page opened from a file.
  if (!url || url.origin === "null" || url.pathname !== "/" || url.search || url.hash)
    throw new TypeError(
      `corsAllowList takes origins, such as "https://app.example.com", and "${entry}" is not one`,
    );
  return url.origin;
}
