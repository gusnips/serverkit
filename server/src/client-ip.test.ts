import { describe, expect, it } from "vitest";
import { clientIpOf, ipSubject } from "./client-ip.ts";

const headers = (init: Record<string, string> = {}) => new Headers(init);

describe("clientIpOf, on a box behind our own proxy", () => {
  it("reads the proxy's hop, the last one, when the peer is the proxy on loopback", () => {
    const forwarded = headers({ "x-forwarded-for": "198.51.100.7, 203.0.113.9" });
    expect(clientIpOf(forwarded, { peer: "127.0.0.1" })).toBe("203.0.113.9");
    expect(clientIpOf(forwarded, { peer: "::1" })).toBe("203.0.113.9");
  });

  it("answers with the peer, and ignores its header, when the peer is anyone else", () => {
    // A caller that reached the port directly wrote this header itself.
    const forged = headers({ "x-forwarded-for": "10.9.9.9" });
    expect(clientIpOf(forged, { peer: "203.0.113.9" })).toBe("203.0.113.9");
  });

  it("knows the proxy on a dual-stack socket, where IPv4 arrives mapped", () => {
    // Measured on Bun: a server bound to "::" sees an IPv4 client as ::ffff:127.0.0.1.
    const forwarded = headers({ "x-forwarded-for": "203.0.113.9" });
    expect(clientIpOf(forwarded, { peer: "::ffff:127.0.0.1" })).toBe("203.0.113.9");
    expect(clientIpOf(headers(), { peer: "::ffff:203.0.113.9" })).toBe("203.0.113.9");
  });

  it("never reads X-Real-IP, which the proxy passes through from the client", () => {
    const realIp = { "x-real-ip": "10.9.9.9" };
    expect(clientIpOf(headers(realIp), { peer: "127.0.0.1" })).toBe("127.0.0.1");
    expect(
      clientIpOf(headers({ ...realIp, "x-forwarded-for": "203.0.113.9" }), { peer: "127.0.0.1" }),
    ).toBe("203.0.113.9");
  });

  it("answers the peer for a process on this box calling without the header", () => {
    expect(clientIpOf(headers(), { peer: "127.0.0.1" })).toBe("127.0.0.1");
  });

  it("answers null, never a shared placeholder, when nothing can be trusted", () => {
    expect(clientIpOf(headers(), { peer: undefined })).toBeNull();
    expect(clientIpOf(headers({ "x-forwarded-for": "unknown" }), { peer: "::1" })).toBeNull();
    // A port is not part of an address; a proxy that writes one is not the proxy described.
    expect(
      clientIpOf(headers({ "x-forwarded-for": "203.0.113.9:443" }), { peer: "::1" }),
    ).toBeNull();
  });
});

describe("clientIpOf, on a platform edge", () => {
  it("reads the platform's header and nothing else", () => {
    const edge = headers({ "cf-connecting-ip": "2001:DB8::9", "x-forwarded-for": "10.9.9.9" });
    expect(clientIpOf(edge, { header: "cf-connecting-ip" })).toBe("2001:db8::9");
    expect(clientIpOf(headers(), { header: "fly-client-ip" })).toBeNull();
  });
});

describe("ipSubject", () => {
  it("puts one IPv6 customer's /56 in one subject", () => {
    expect(ipSubject("2001:db8:1234:56ff::1")).toBe("2001:db8:1234:5600::/56");
    expect(ipSubject("2001:db8:1234:5601:ffff::9")).toBe("2001:db8:1234:5600::/56");
    expect(ipSubject("2001:db8:1234:5700::1")).not.toBe(ipSubject("2001:db8:1234:5600::1"));
  });

  it("takes another prefix", () => {
    expect(ipSubject("2001:db8:1:2:3:4:5:6", 64)).toBe("2001:db8:1:2::/64");
    expect(ipSubject("2001:db8:1:2:3:4:5:6", 128)).toBe("2001:db8:1:2:3:4:5:6/128");
  });

  it("leaves IPv4 alone, folds a mapped address to it, and passes anything else through", () => {
    expect(ipSubject("203.0.113.9")).toBe("203.0.113.9");
    expect(ipSubject("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(ipSubject("not-an-address")).toBe("not-an-address");
    expect(ipSubject(null)).toBeNull();
  });
});
