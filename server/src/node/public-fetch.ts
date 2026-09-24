/**
 * The half of the SSRF guard that needs a real network stack: resolve a name once, refuse it if
 * ANY answer is not public, and send the request to the address that was checked. The pure half
 * (`checkUrlShape`, `nextHop`, `readBounded`) is in `.`, and each step here runs it first.
 *
 * Why the dial is pinned. Checking a name and then handing it to `fetch` resolves it twice, and a
 * DNS server that answers public, then private, wins the gap between the two. Five backends in one
 * fleet dialled that way, three of them under a comment saying so. `fetch` offers no hook to fix it
 * in Node, so this uses `node:https` to the IP literal, with the name in `servername` and in `Host`.
 *
 * Measured on Node 22.22 and Bun 1.4.2, against a local CA and against a public host: both check
 * the certificate against `servername`, refuse a wrong one, and fall back to `Host` without one.
 * The tests beside this file pass on both. **Bun 1.3.8 fails two of them.** It ignores
 * `servername` and checks the `Host` header verbatim, port included, so an https URL on any port
 * but 443 is refused there. And when a reused connection is reset, it sends the request again on
 * its own, so a webhook can arrive twice. Run this on Bun 1.4.2 or later.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline, Readable } from "node:stream";
import { constants, createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import {
  checkUrlShape,
  isAllowedAddress,
  nextHop,
  type UrlPolicy,
  type UrlRefusal,
} from "../url-guard.ts";

/** Every address a name has. The default is `dns.lookup`, which reads /etc/hosts like the OS. */
export type Resolve = (host: string) => Promise<string[]>;

export interface PublicTarget {
  url: URL;
  /** Every answer, IPv4 first. The check covers the whole set, so each one is safe to dial. */
  addresses: string[];
}

export interface ResolveOptions {
  /** Bounds the lookup, the one step with no timeout of its own. */
  signal: AbortSignal;
  policy?: UrlPolicy;
  /** For a test. */
  resolve?: Resolve;
}

/**
 * `checkUrlShape`, then resolve the name once and refuse it if ANY answer is not public. A name
 * with one public and one private record is refused as a whole, so every address that comes back
 * is equally safe to dial.
 *
 * A name DNS does not know is `unresolvable`. A lookup that FAILED — the resolver timed out, or
 * is down — throws, because telling a customer their host does not exist when ours is what broke
 * is the wrong cause. An aborted `signal` throws its reason, the way `fetch` does.
 */
export async function resolvePublic(
  raw: string | URL,
  options: ResolveOptions,
): Promise<({ ok: true } & PublicTarget) | UrlRefusal> {
  const shape = checkUrlShape(raw, options.policy);
  if (!shape.ok) return shape;
  let addresses = shape.literal === null ? [] : [shape.literal];
  if (shape.literal === null) {
    try {
      addresses = await untilAborted(
        (options.resolve ?? systemResolve)(shape.url.hostname),
        options.signal,
      );
    } catch (error) {
      if (!NOT_FOUND.has(codeOf(error))) throw error;
    }
  }
  if (addresses.length === 0) return { ok: false, reason: "unresolvable" };
  if (!addresses.every((address) => isAllowedAddress(address, options.policy)))
    return { ok: false, reason: "private-address" };
  // A box with no IPv6 route fails an IPv6 dial slowly or not at all, and the customer is the one
  // told their endpoint is down. IPv4 first; the sort is stable, so DNS order holds within each.
  addresses.sort((a, b) => Number(a.includes(":")) - Number(b.includes(":")));
  return { ok: true, url: shape.url, addresses };
}

export interface PinnedInit {
  method?: string;
  headers?: Headers | Record<string, string>;
  body?: string | Uint8Array;
  /**
   * Required: it bounds the connect, the wait for an answer and the body. A caller that forgot it
   * once left a webhook with no deadline at all. `AbortSignal.timeout(10_000)` is the usual one.
   */
  signal: AbortSignal;
}

/**
 * Send one request to an address `resolvePublic` checked, and answer with a real `Response`. It
 * follows no redirect. The body is decoded (gzip, deflate, br), so `readBounded` caps the bytes
 * that come out, not the bytes that went over the wire. Read the body or cancel it.
 *
 * It tries the next address only when the one before refused the connection. After a timeout it
 * stops: a timeout cannot tell "never arrived" from "arrived late", and the next address would
 * deliver a webhook twice.
 *
 * ponytail: one deadline across every address, so an address that drops packets rather than
 * refusing uses the whole of it and the next never gets a turn. A per-address share of the
 * deadline is the upgrade, if an adopter ever sees it.
 */
export async function pinnedRequest(target: PublicTarget, init: PinnedInit): Promise<Response> {
  let lastError: unknown = new Error(`No address to send to for ${target.url.hostname}`);
  for (const address of target.addresses) {
    try {
      return await dial(target.url, address, init);
    } catch (error) {
      if (!NEVER_CONNECTED.has(codeOf(error))) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export interface PublicFetchInit extends PinnedInit {
  policy?: UrlPolicy;
  /** Default 5. `0` follows nothing and hands a redirect back as the answer: a webhook's setting. */
  maxRedirects?: number;
  /** For a test. */
  resolve?: Resolve;
}

export interface PublicFetchResult {
  ok: true;
  response: Response;
  /** Where the answer came from, after any redirects. */
  url: URL;
  redirects: number;
}

/**
 * `fetch` for a URL a customer gave you. Every hop is checked before it is sent: its shape, then
 * every address its name resolves to, then the request goes to one of those addresses. A redirect
 * changes the request the way fetch changes it, and `Authorization`, `Cookie` and
 * `Proxy-Authorization` stop at the origin they were meant for.
 *
 * A refusal comes back as `{ ok: false, reason }`, so the 400 is yours to word. What `fetch`
 * throws, this throws: the signal's reason on abort, a network error when no address answers.
 */
export async function fetchPublic(
  raw: string | URL,
  init: PublicFetchInit,
): Promise<PublicFetchResult | UrlRefusal> {
  const { policy, resolve, signal, maxRedirects = 5 } = init;
  let method = init.method ?? "GET";
  let headers = new Headers(init.headers);
  let body = init.body;
  let target = await resolvePublic(raw, { policy, resolve, signal });
  for (let redirects = 0; ; redirects++) {
    if (!target.ok) return target;
    const response = await pinnedRequest(target, { method, headers, body, signal });
    const hop =
      maxRedirects === 0 ? null : nextHop(target.url, response, { method, headers }, policy);
    if (hop === null) return { ok: true, response, url: target.url, redirects };
    await response.body?.cancel().catch(() => undefined);
    if (!hop.ok) return hop;
    if (redirects === maxRedirects) return { ok: false, reason: "too-many-redirects" };
    ({ method, headers } = hop);
    if (hop.dropBody) body = undefined;
    target = await resolvePublic(hop.url, { policy, resolve, signal });
  }
}

const systemResolve: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((answer) => answer.address);

/** DNS answered, and the answer was "no such name". Anything else is DNS failing to answer. */
const NOT_FOUND = new Set<string | undefined>(["ENOTFOUND", "ENODATA"]);

/** The connection was refused before a byte was sent, so another address is a real second try. */
const NEVER_CONNECTED = new Set<string | undefined>([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
]);

function codeOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

/** `getaddrinfo` cannot be cancelled, but nobody has to keep waiting for it. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function dial(url: URL, address: string, init: PinnedInit): Promise<Response> {
  const { signal } = init;
  if (signal.aborted) return Promise.reject(signal.reason);
  const secure = url.protocol === "https:";
  const name = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const payload = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => (headers[name] = value));
  // The name the customer registered, not the address we dialled: it picks the virtual host.
  headers.host = url.host;
  if (payload) headers["content-length"] = String(payload.byteLength);
  const options: RequestOptions & { servername?: string } = {
    host: address,
    port: url.port ? Number(url.port) : secure ? 443 : 80,
    path: `${url.pathname}${url.search}`,
    method: init.method ?? "GET",
    headers,
  };
  // The certificate is checked against this name. A URL whose host is an address has no name to
  // send, and TLS forbids an address there, so the check falls to the address itself.
  if (secure && !isIpLiteral(name)) options.servername = name;

  return new Promise<Response>((resolve, reject) => {
    const request = (secure ? httpsRequest : httpRequest)(options);
    let response: IncomingMessage | undefined;
    const abort = () => {
      // Destroying the response, once there is one, is what makes a body read reject with the
      // signal's own reason, so a timeout mid-body reads as a TimeoutError, as it does in fetch.
      (response ?? request).destroy(signal.reason);
      // A connect that is aborted may emit nothing at all (Bun 1.3.8 did not), so the signal
      // rejects directly rather than waiting on an event that may not come.
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    const done = () => signal.removeEventListener("abort", abort);
    request.on("error", (error) => {
      done();
      reject(error);
    });
    request.on("response", (incoming) => {
      response = incoming;
      incoming.on("close", done);
      // An error while nobody reads the body must not become an uncaught exception.
      incoming.on("error", () => undefined);
      try {
        resolve(toResponse(incoming, options.method ?? "GET"));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.end(payload);
  });
}

/** Statuses whose answer has no body, whatever the server sends. Node refuses to build a
 *  `Response` with one; Bun builds it, so the check is here and not left to the runtime. */
const NO_BODY = new Set([204, 205, 304]);

function toResponse(incoming: IncomingMessage, method: string): Response {
  const status = incoming.statusCode ?? 0;
  const headers = new Headers();
  // `rawHeaders`, not `headers`: the parsed object folds a repeated header into one value, and
  // a second `Set-Cookie` would be lost.
  for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2)
    headers.append(incoming.rawHeaders[i] ?? "", incoming.rawHeaders[i + 1] ?? "");
  if (NO_BODY.has(status) || method.toUpperCase() === "HEAD") {
    incoming.resume();
    return new Response(null, { status, headers });
  }
  const decoder = decoderFor(headers.get("content-encoding"));
  if (decoder) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }
  // `pipeline`, not `pipe`: a socket that dies mid-body must fail the decoder too, or the body
  // read waits forever on a decoder nobody told.
  const stream = decoder ? pipeline(incoming, decoder, () => undefined) : incoming;
  return new Response(Readable.toWeb(stream), { status, headers });
}

/**
 * One server-side choice a browser never has to make: decode what the server compressed even
 * when nobody asked, so a size limit counts the bytes that come out. Only a single coding;
 * anything else passes through with its header, for the caller to see. Lenient flushing, as
 * undici does, so a server that forgets the gzip trailer still reads.
 */
function decoderFor(encoding: string | null) {
  switch (encoding?.trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return createGunzip({ flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH });
    case "deflate":
      return createInflate({ flush: constants.Z_SYNC_FLUSH, finishFlush: constants.Z_SYNC_FLUSH });
    case "br":
      return createBrotliDecompress({
        flush: constants.BROTLI_OPERATION_FLUSH,
        finishFlush: constants.BROTLI_OPERATION_FLUSH,
      });
    default:
      return null;
  }
}

function isIpLiteral(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}
