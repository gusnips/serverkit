/**
 * Which address a request came from, trusting only what cannot be forged.
 *
 * Ten readers in the fleet, three designs. Most read the last `X-Forwarded-For` hop, which is
 * right behind our own proxy and only there. Six of the fleet's APIs listen on every interface,
 * and unless a firewall closes the port, a caller that reaches it directly writes that hop
 * itself: every request can carry a fresh address, and so a fresh rate-limit allowance. One
 * design asks the socket first and reads the header only when the socket is the proxy on this
 * box, which is safe on any bind. It then read `X-Real-IP` ahead of the header, and its proxy
 * passes a client's own `X-Real-IP` through by default, so it was forgeable after all. This file
 * is that design, with `X-Real-IP` never read.
 *
 * `null` rather than `"unknown"` when no address can be trusted. Seven readers answered
 * `"unknown"`, which puts every such request in one shared rate-limit window that one caller can
 * fill for everyone. Whether that is acceptable is the caller's decision, so it is the caller's
 * `?? "unknown"` to write.
 */
import { ipv6Groups, isLoopbackAddress, parseIpv4 } from "./ip.ts";

/** A platform whose edge sets this header on every request and drops the client's own copy. */
export type PlatformIpHeader = "cf-connecting-ip" | "fly-client-ip";

export type ClientIpSource =
  /**
   * On a box behind our own proxy: the socket peer's address. The last `X-Forwarded-For` hop is
   * read only when that peer is loopback, which is the proxy, because that hop is the one the
   * proxy wrote. From anywhere else the peer IS the client, and its header is its own claim.
   */
  | { peer: string | undefined }
  /**
   * A Worker, or an app on Fly. Only where every request passes that edge: a box behind a
   * proxied Cloudflare record is not such a place, because anyone who finds the box's address
   * can send the header themselves. Use `peer` there.
   */
  | { header: PlatformIpHeader };

/**
 * The client's address, or `null` when none can be trusted: no peer, a header that is missing,
 * or a value that is not an address. An IPv4 client on a dual-stack socket arrives as
 * `::ffff:203.0.113.9`, and comes back as `203.0.113.9`, so one client has one address.
 */
export function clientIpOf(headers: Headers, source: ClientIpSource): string | null {
  if ("header" in source) return addressOf(headers.get(source.header));
  const peer = addressOf(source.peer);
  // ponytail: loopback is the only proxy trusted. A proxy on a container network reaches the
  // app from its own address, which reads as one client for every request. The upgrade is a
  // trusted-peer predicate beside `peer`; no deployment in the fleet needs it yet.
  if (peer === null || !isLoopbackAddress(peer)) return peer;
  const forwarded = headers.get("x-forwarded-for");
  // No header from loopback is a process on this box calling directly, so the peer is right.
  if (forwarded === null) return peer;
  return addressOf(forwarded.split(",").at(-1));
}

/**
 * The rate-limit subject for an address: an IPv6 address becomes its `/v6Prefix` network
 * (default 56, the value express-rate-limit settled on), and IPv4 is left alone.
 *
 * A single IPv6 customer is usually handed a /64 or more, so keyed by the full address one
 * client has 2^64 fresh windows. No limiter in the fleet masked it. Anything that is not an
 * address comes back unchanged. `null` stays `null`, so a limiter keyed on
 * `ipSubject(c.get("clientIp"))` lets a request with no trusted address through uncounted.
 */
export function ipSubject(ip: string, v6Prefix?: number): string;
export function ipSubject(ip: string | null, v6Prefix?: number): string | null;
export function ipSubject(ip: string | null, v6Prefix = 56): string | null {
  if (ip === null) return null;
  const address = addressOf(ip);
  const groups = address === null ? null : ipv6Groups(address);
  if (groups === null) return address ?? ip;
  const kept = Math.ceil(v6Prefix / 16);
  const masked = groups
    .slice(0, kept)
    .map((group, i) => group & (0xffff << Math.max(0, 16 * (i + 1) - v6Prefix)) & 0xffff);
  return `${masked.map((group) => group.toString(16)).join(":")}${kept < 8 ? "::" : ""}/${v6Prefix}`;
}

/** A trimmed IPv4 or IPv6 literal, with an IPv4-mapped IPv6 address folded to IPv4. */
function addressOf(text: string | null | undefined): string | null {
  const value = text?.trim();
  if (!value) return null;
  if (parseIpv4(value) !== null) return value;
  const groups = ipv6Groups(value);
  if (groups === null) return null;
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (!mapped) return value.toLowerCase();
  const [high = 0, low = 0] = groups.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}
