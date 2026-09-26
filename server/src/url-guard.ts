/**
 * The half of an SSRF guard that runs anywhere, a Cloudflare Worker included: is this address
 * public, may we dial a URL shaped like this, where does a redirect go next, and how to read a
 * body without trusting its size. Where a name RESOLVES, and dialling the address that was
 * checked rather than whatever DNS answers a moment later, need `node:dns` and `node:http`, so
 * that half is `@gusnips/server/node`.
 *
 * Twelve backends wrote this in six independent lineages, and two shipped a hole a sibling had
 * already closed. One followed redirects and checked only where it landed, so every hop in
 * between had already been requested from the box. One judged an IPv4-mapped IPv6 address only
 * in its dotted form, and the URL parser writes that form in hex. The most-copied lineage let
 * through 9 to 13 of 32 addresses that must be refused, carrier-grade NAT among them in two
 * copies. The test beside this file refuses each of those forms by name.
 *
 * Everything answers with a result, never a throw, because each product words its own refusal.
 */
import { dottedToNumber, ipv6Groups, isLoopbackAddress, parseIpv4, unbracket } from "./ip.ts";

export type UrlRefusalReason =
  /** Not a URL, or a redirect's `Location` is not one. */
  | "invalid"
  /** A scheme the policy does not allow, including an https→http redirect under the default. */
  | "scheme"
  /** `user:password@` in the URL. Credentials go in a header, where a log line does not print them. */
  | "credentials"
  | "port"
  /** A name that only means something inside a network: `localhost`, `redis`, `*.internal`. */
  | "internal-name"
  /** The host is, or resolves to, an address that is not public. */
  | "private-address"
  /** DNS knows no such host. Only `/node` resolves, so only `/node` answers this. */
  | "unresolvable"
  | "too-many-redirects";

export interface UrlRefusal {
  ok: false;
  reason: UrlRefusalReason;
}

export interface UrlPolicy {
  /** Default `["https:"]`. A reader of pasted links passes `["http:", "https:"]`. */
  schemes?: readonly ("http:" | "https:")[];
  /**
   * Default `"any"`. `[80, 443]` is the smaller blast radius when nothing needs more: DNS can move
   * a host, and it cannot move a port.
   */
  ports?: readonly number[] | "any";
  /** Default `"refuse"`. A proxy URL is the one place credentials belong in the URL. */
  credentials?: "refuse" | "allow";
  /**
   * Let `localhost`, 127.0.0.0/8 and `::1` through, for a test or a laptop. Nothing else: never a
   * private range, never the metadata service. A flag that skipped the whole guard existed in two
   * donors, switched on by an environment variable nothing refused in production. It leaves the
   * scheme alone, so a receiver at `http://localhost:4000/` also needs `schemes: ["http:", "https:"]`.
   */
  allowLoopback?: boolean;
}

export interface UrlShape {
  ok: true;
  url: URL;
  /** The host when it is an IP address, without brackets. `null` for a name, which is unchecked
   *  until something resolves it. */
  literal: string | null;
}

/**
 * True only for an address our box may send a request to: not loopback, not private, not
 * link-local (the cloud metadata service is 169.254.169.254), not carrier-grade NAT, not
 * reserved. An address that does not parse is not public, so a spelling nobody anticipated is
 * refused rather than waved through. Accepts the bracketed form a URL's `hostname` carries.
 */
export function isPublicAddress(address: string): boolean {
  const ip = unbracket(address);
  const v4 = parseIpv4(ip);
  if (v4 !== null) return !NON_PUBLIC_IPV4.some((block) => inBlock(v4, block));
  const groups = ipv6Groups(ip);
  return groups !== null && isPublicIpv6(groups);
}

/** Names that only mean something inside a network, whatever they resolve to. */
export function isInternalHostname(host: string): boolean {
  const name = normalizeName(host);
  return (
    isLoopbackName(name) ||
    [".local", ".internal", ".arpa"].some((suffix) => name.endsWith(suffix)) ||
    // A bare name ("redis", "kong") goes through the box's own search domains and /etc/hosts,
    // so it is never a public host. The colon keeps an IPv6 literal out of this rule.
    (!name.includes(".") && !name.includes(":"))
  );
}

/**
 * Everything that can be decided without DNS: the scheme, credentials, the port, the name, and
 * the address when the host is an IP literal. `new URL` has already turned `2130706433`,
 * `0x7f.1` and `127.1` into `127.0.0.1`, so the literal judged here is the one a socket would
 * dial.
 *
 * A name comes back unchecked (`literal: null`). In a Worker that is the whole check, because a
 * Worker cannot resolve a name, and the network behind its `fetch` is not our box's. On a server,
 * `resolvePublic` in `/node` finishes the job.
 */
export function checkUrlShape(raw: string | URL, policy: UrlPolicy = {}): UrlShape | UrlRefusal {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse("invalid");
  }
  const schemes = policy.schemes ?? ["https:"];
  if (!schemes.some((scheme) => scheme === url.protocol)) return refuse("scheme");
  if ((url.username || url.password) && policy.credentials !== "allow")
    return refuse("credentials");
  const ports = policy.ports ?? "any";
  if (ports !== "any" && !ports.includes(portOf(url))) return refuse("port");

  const host = unbracket(url.hostname);
  if (isInternalHostname(host) && !(policy.allowLoopback && isLoopbackName(normalizeName(host))))
    return refuse("internal-name");
  if (parseIpv4(host) === null && ipv6Groups(host) === null)
    return { ok: true, url, literal: null };
  if (!isAllowedAddress(host, policy)) return refuse("private-address");
  return { ok: true, url, literal: host };
}

export interface Hop extends UrlShape {
  /** `GET` where fetch would rewrite it, otherwise the method as sent. */
  method: string;
  /** Send no body on this hop: the method became `GET`. */
  dropBody: boolean;
  /** A copy. The body's headers go with the body, and credentials stay with their origin. */
  headers: Headers;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that describe a request body, dropped when a redirect drops the body. */
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"];

/** Credentials meant for one origin. The fetch spec names only the first; undici drops all
 *  three, and the last two each took a CVE to get there. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/**
 * Where a redirect goes, changed the way fetch changes it, and checked like the first URL was.
 * `null` when the answer is not a redirect. Follow one with `redirect: "manual"` and this, never
 * with `redirect: "follow"` and a check at the end: by the time the end is checked, every hop
 * in between has been requested.
 *
 * A 301 or 302 answering a POST, and a 303 answering anything but GET or HEAD, turn the request
 * into a GET with no body. `Authorization`, `Cookie` and `Proxy-Authorization` do not cross to
 * another origin. The hop count is the caller's: a webhook follows none.
 */
export function nextHop(
  from: URL,
  response: { status: number; headers: Headers },
  request: { method: string; headers: Headers },
  policy?: UrlPolicy,
): Hop | UrlRefusal | null {
  const location = response.headers.get("location");
  if (!REDIRECT_STATUSES.has(response.status) || location === null) return null;
  let target: URL;
  try {
    target = new URL(location, from);
  } catch {
    return refuse("invalid");
  }
  const shape = checkUrlShape(target, policy);
  if (!shape.ok) return shape;

  const method = request.method.toUpperCase();
  const toGet =
    ((response.status === 301 || response.status === 302) && method === "POST") ||
    (response.status === 303 && method !== "GET" && method !== "HEAD");
  const headers = new Headers(request.headers);
  // The next hop names its own host; a copied one would send it to the wrong virtual host.
  headers.delete("host");
  if (toGet) for (const name of BODY_HEADERS) headers.delete(name);
  if (shape.url.origin !== from.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return { ...shape, method: toGet ? "GET" : request.method, dropBody: toGet, headers };
}

/**
 * Read at most `maxBytes` of a body, then cancel the rest so the connection is released. It
 * never trusts `Content-Length`: a server can lie about it, and a compressed body does not have
 * one that means anything. `truncated` says the body was longer; a caller that needs the whole
 * thing (an image, a JSON document) refuses on it. Decode text with `new TextDecoder()`.
 */
export async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = body?.getReader();
  for (;;) {
    const read = await reader?.read();
    if (!read || read.done) return { bytes: concat(chunks, total), truncated: false };
    const room = maxBytes - total;
    if (read.value.byteLength > room) {
      chunks.push(read.value.subarray(0, room));
      total += room;
      await reader?.cancel().catch(() => undefined);
      return { bytes: concat(chunks, total), truncated: true };
    }
    chunks.push(read.value);
    total += read.value.byteLength;
  }
}

/** For `/node`: an address the policy lets a socket reach. Loopback only when it says so. */
export function isAllowedAddress(address: string, policy: UrlPolicy = {}): boolean {
  return isPublicAddress(address) || (policy.allowLoopback === true && isLoopbackAddress(address));
}

function refuse(reason: UrlRefusalReason): UrlRefusal {
  return { ok: false, reason };
}

/** A trailing dot is the same host: `localhost.` is localhost. */
function normalizeName(host: string): string {
  return unbracket(host).toLowerCase().replace(/\.+$/, "");
}

function isLoopbackName(name: string): boolean {
  return name === "localhost" || name.endsWith(".localhost");
}

function portOf(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// What counts as public. The parsers are in ip.ts, shared with the client-address reader.

interface Block {
  base: number;
  size: number;
}

/** Every IPv4 block that is not a public host. */
const NON_PUBLIC_IPV4: readonly Block[] = (
  [
    ["0.0.0.0", 8], // "this network"; 0.0.0.0 itself reaches the box on Linux
    ["10.0.0.0", 8],
    ["100.64.0.0", 10], // carrier-grade NAT, where Tailscale peers and one cloud's metadata live
    ["127.0.0.0", 8],
    ["169.254.0.0", 16], // link-local, including cloud metadata
    ["172.16.0.0", 12],
    ["192.0.0.0", 24], // protocol assignments
    ["192.0.2.0", 24], // documentation
    ["192.88.99.0", 24], // 6to4 relay anycast
    ["192.168.0.0", 16],
    ["198.18.0.0", 15], // benchmarking
    ["198.51.100.0", 24], // documentation
    ["203.0.113.0", 24], // documentation
    ["224.0.0.0", 3], // multicast, reserved and broadcast
  ] as const
).map(([first, prefix]) => ({ base: dottedToNumber(first), size: 2 ** (32 - prefix) }));

function inBlock(address: number, { base, size }: Block): boolean {
  return Math.floor(address / size) === Math.floor(base / size);
}

/**
 * IPv6 is checked against an ALLOW-list: only global unicast (2000::/3) is public, minus the
 * blocks inside it that carry an IPv4 address or no real host. Every IPv4-embedding form —
 * mapped (`::ffff:…`), compatible, NAT64 — sits outside 2000::/3, so it is refused however it
 * is spelled. That is the point: `https://[::ffff:127.0.0.1]` reaches here as `::ffff:7f00:1`,
 * and a list of bad prefixes that knew only the dotted spelling let it reach loopback.
 */
function isPublicIpv6(groups: readonly number[]): boolean {
  const [first = 0, second = 0] = groups;
  if ((first & 0xe000) !== 0x2000) return false;
  if (first === 0x2002) return false; // 6to4: embeds an IPv4 address
  // IETF protocol assignments, 2001::/23, refused whole like their IPv4 twin 192.0.0.0/24: Teredo
  // (which embeds an IPv4 address too), benchmarking (the twin of 198.18.0.0/15) and ORCHID. The
  // few anycast services in it answer protocols, never a webhook or a page.
  if (first === 0x2001 && second < 0x0200) return false;
  if (first === 0x2001 && second === 0x0db8) return false; // documentation
  if (first === 0x3fff && second < 0x1000) return false; // documentation, 3fff::/20
  return true;
}
