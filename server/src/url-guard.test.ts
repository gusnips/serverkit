import { describe, expect, it } from "vitest";
import {
  checkUrlShape,
  isAllowedAddress,
  isInternalHostname,
  isPublicAddress,
  nextHop,
  readBounded,
} from "./url-guard.ts";

describe("isPublicAddress", () => {
  // Every form some copy in the fleet let through, and the neighbours that make a block's edge.
  const notPublic = [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1", // carrier-grade NAT: two copies passed it
    "100.100.100.200", // one cloud's metadata service, inside CGNAT
    "100.127.255.255",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // the hex spelling `new URL` writes, which one copy judged public
    "::ffff:a9fe:a9fe", // metadata, mapped, in hex
    "0:0:0:0:0:ffff:7f00:1",
    "::7f00:1", // IPv4-compatible
    "64:ff9b::7f00:1", // NAT64
    "2002:7f00:1::1", // 6to4
    "2001::1", // Teredo
    "2001:db8::1",
    "3fff::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0", // a zone id, which one runtime's BlockList let through
    "fec0::1", // site-local
    "ff02::1",
    "100::1", // discard
  ];
  it.each(notPublic)("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  const unparseable = [
    "",
    "localhost",
    "256.0.0.1",
    "1.2.3",
    "0177.0.0.1", // octal to one parser, decimal to another
    "0x7f.0.0.1",
    "2130706433",
    "1::2::3",
    "1:2:3:4:5:6:7:8:9",
    "1:2:3:4:5:6:7::8",
    "::ffff:300.0.0.1",
    "127.0.0.1%eth0",
    "gggg::1",
  ];
  it.each(unparseable)("refuses %j, which does not parse", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  const isPublic = [
    "8.8.8.8",
    "1.1.1.1",
    "11.0.0.1",
    "100.63.255.255",
    "100.128.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "198.20.0.0",
    "223.255.255.255",
    "2606:4700::1111",
    "2a00:1450:4001:80b::200e",
    "[2606:4700::1111]", // as a URL's hostname carries it
    "2001:4860:4860::8888",
    "3fff:1000::1",
    "2001:db9::1",
    "2600::8.8.8.8", // a dotted tail on a public prefix
  ];
  it.each(isPublic)("lets %s through", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("isAllowedAddress", () => {
  it("relaxes loopback and nothing else", () => {
    const policy = { allowLoopback: true };
    expect(isAllowedAddress("127.0.0.1", policy)).toBe(true);
    expect(isAllowedAddress("127.8.8.8", policy)).toBe(true);
    expect(isAllowedAddress("::1", policy)).toBe(true);
    expect(isAllowedAddress("[::1]", policy)).toBe(true);
    for (const address of ["10.0.0.1", "169.254.169.254", "::ffff:7f00:1", "::", "0.0.0.0"])
      expect(isAllowedAddress(address, policy)).toBe(false);
    expect(isAllowedAddress("127.0.0.1")).toBe(false);
  });
});

describe("isInternalHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "localhost.",
    "api.localhost",
    "printer.local",
    "metadata.google.internal",
    "1.0.0.127.in-addr.arpa",
    "home.arpa",
    "redis",
    "kong",
    "",
  ])("refuses %j", (host) => {
    expect(isInternalHostname(host)).toBe(true);
  });

  it.each(["example.com", "example.com.", "8.8.8.8", "2606:4700::1111", "[::1]"])(
    "leaves %j to the address check",
    (host) => {
      expect(isInternalHostname(host)).toBe(false);
    },
  );
});

describe("checkUrlShape", () => {
  const both = { schemes: ["http:", "https:"] } as const;

  it("accepts a public name and leaves it unresolved", () => {
    const shape = checkUrlShape("https://example.com/hook");
    expect(shape).toMatchObject({ ok: true, literal: null });
    expect(shape.ok && shape.url.href).toBe("https://example.com/hook");
  });

  it("reports a public literal without its brackets", () => {
    expect(checkUrlShape("https://8.8.8.8/")).toMatchObject({ ok: true, literal: "8.8.8.8" });
    expect(checkUrlShape("https://[2606:4700::1111]/")).toMatchObject({
      ok: true,
      literal: "2606:4700::1111",
    });
  });

  it.each([
    ["not a url", "invalid"],
    ["http://example.com", "scheme"],
    ["ftp://example.com", "scheme"],
    ["file:///etc/passwd", "scheme"],
    ["https://user:secret@example.com", "credentials"],
    ["https://localhost/", "internal-name"],
    ["https://localhost./", "internal-name"],
    ["https://redis:6379/", "internal-name"],
    ["https://metadata.google.internal/", "internal-name"],
    ["https://127.0.0.1/", "private-address"],
    // `new URL` rewrites each of these to a dotted or hex form before the check sees it.
    ["https://2130706433/", "private-address"],
    ["https://0x7f.1/", "private-address"],
    ["https://127.1/", "private-address"],
    ["https://[::ffff:127.0.0.1]/", "private-address"],
    ["https://[0:0:0:0:0:ffff:a9fe:a9fe]/", "private-address"],
    ["https://169.254.169.254/latest/meta-data/", "private-address"],
  ])("refuses %s: %s", (raw, reason) => {
    expect(checkUrlShape(raw)).toEqual({ ok: false, reason });
  });

  it("takes http only when the policy says so", () => {
    expect(checkUrlShape("http://example.com", both)).toMatchObject({ ok: true });
  });

  it("lets credentials through for a proxy URL, and keeps them", () => {
    const shape = checkUrlShape("https://user:secret@proxy.example.com", { credentials: "allow" });
    expect(shape.ok && shape.url.username).toBe("user");
  });

  it("holds the port to the list, counting the scheme's default", () => {
    const policy = { ...both, ports: [80, 443] };
    expect(checkUrlShape("https://example.com", policy)).toMatchObject({ ok: true });
    expect(checkUrlShape("http://example.com", policy)).toMatchObject({ ok: true });
    expect(checkUrlShape("http://example.com:443", policy)).toMatchObject({ ok: true });
    expect(checkUrlShape("https://example.com:6379", policy)).toEqual({
      ok: false,
      reason: "port",
    });
  });

  it("relaxes loopback, and only loopback, when asked", () => {
    const policy = { ...both, allowLoopback: true };
    expect(checkUrlShape("http://127.0.0.1:3000", policy)).toMatchObject({
      ok: true,
      literal: "127.0.0.1",
    });
    expect(checkUrlShape("http://[::1]:3000", policy)).toMatchObject({ ok: true, literal: "::1" });
    expect(checkUrlShape("http://localhost:3000", policy)).toMatchObject({
      ok: true,
      literal: null,
    });
    expect(checkUrlShape("http://10.0.0.1", policy)).toEqual({
      ok: false,
      reason: "private-address",
    });
    expect(checkUrlShape("http://169.254.169.254", policy)).toEqual({
      ok: false,
      reason: "private-address",
    });
    expect(checkUrlShape("http://redis:6379", policy)).toEqual({
      ok: false,
      reason: "internal-name",
    });
  });
});

describe("nextHop", () => {
  const from = new URL("https://api.example.com/start");
  const answer = (status: number, location?: string) => ({
    status,
    headers: new Headers(location === undefined ? {} : { location }),
  });
  const post = () => ({
    method: "POST",
    headers: new Headers({
      authorization: "Bearer t",
      cookie: "s=1",
      "proxy-authorization": "Basic p",
      "content-type": "application/json",
      "x-trace": "abc",
      host: "api.example.com",
    }),
  });

  it("is null for an answer that is not a redirect", () => {
    expect(nextHop(from, answer(200), post())).toBeNull();
    expect(nextHop(from, answer(304, "/x"), post())).toBeNull();
    expect(nextHop(from, answer(300, "/x"), post())).toBeNull();
    expect(nextHop(from, answer(302), post())).toBeNull();
  });

  it("turns a POST answered by 302 into a GET with no body", () => {
    const hop = nextHop(from, answer(302, "/next"), post());
    expect(hop).toMatchObject({ ok: true, method: "GET", dropBody: true });
    if (!hop?.ok) throw new Error("expected a hop");
    expect(hop.url.href).toBe("https://api.example.com/next");
    expect(hop.headers.has("content-type")).toBe(false);
    expect(hop.headers.get("authorization")).toBe("Bearer t");
  });

  it("keeps the method and body across 307 and 308", () => {
    for (const status of [307, 308]) {
      const hop = nextHop(from, answer(status, "/next"), post());
      expect(hop).toMatchObject({ ok: true, method: "POST", dropBody: false });
      expect(hop?.ok && hop.headers.get("content-type")).toBe("application/json");
    }
  });

  it("turns anything but GET or HEAD answered by 303 into a GET", () => {
    const put = { method: "put", headers: new Headers() };
    expect(nextHop(from, answer(303, "/next"), put)).toMatchObject({ method: "GET" });
    const head = { method: "HEAD", headers: new Headers() };
    expect(nextHop(from, answer(303, "/next"), head)).toMatchObject({
      method: "HEAD",
      dropBody: false,
    });
  });

  it("keeps a method it does not rewrite exactly as sent", () => {
    const patch = { method: "patch", headers: new Headers() };
    expect(nextHop(from, answer(301, "/next"), patch)).toMatchObject({ method: "patch" });
  });

  it("drops credentials when the origin changes, and never the caller's copy", () => {
    const request = post();
    const hop = nextHop(from, answer(307, "https://cdn.example.net/x"), request);
    if (!hop?.ok) throw new Error("expected a hop");
    for (const name of ["authorization", "cookie", "proxy-authorization", "host"])
      expect(hop.headers.has(name)).toBe(false);
    expect(hop.headers.get("x-trace")).toBe("abc");
    expect(request.headers.get("authorization")).toBe("Bearer t");
  });

  it("counts a port change as another origin", () => {
    const hop = nextHop(from, answer(307, "https://api.example.com:8443/x"), post());
    expect(hop?.ok && hop.headers.has("authorization")).toBe(false);
  });

  it("checks where the redirect goes like the first URL", () => {
    const both = { schemes: ["http:", "https:"] } as const;
    expect(nextHop(from, answer(302, "http://169.254.169.254/"), post(), both)).toEqual({
      ok: false,
      reason: "private-address",
    });
    expect(nextHop(from, answer(302, "https://[::ffff:7f00:1]/"), post())).toEqual({
      ok: false,
      reason: "private-address",
    });
    expect(nextHop(from, answer(302, "https://localhost/"), post())).toEqual({
      ok: false,
      reason: "internal-name",
    });
    // Under the default https-only policy, a downgrade is refused rather than followed.
    expect(nextHop(from, answer(301, "http://api.example.com/"), post())).toEqual({
      ok: false,
      reason: "scheme",
    });
    expect(nextHop(from, answer(302, "http://[::1"), post())).toEqual({
      ok: false,
      reason: "invalid",
    });
  });
});

describe("readBounded", () => {
  function stream(chunks: number[], onCancel?: () => void): ReadableStream<Uint8Array> {
    const queue = chunks.map((size, i) => new Uint8Array(size).fill(i + 1));
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = queue.shift();
        if (next) controller.enqueue(next);
        else controller.close();
      },
      cancel: onCancel,
    });
  }

  it("reads a body under the limit whole", async () => {
    const { bytes, truncated } = await readBounded(stream([3, 4]), 10);
    expect([...bytes]).toEqual([1, 1, 1, 2, 2, 2, 2]);
    expect(truncated).toBe(false);
  });

  it("is not truncated at exactly the limit", async () => {
    const { bytes, truncated } = await readBounded(stream([5, 5]), 10);
    expect(bytes.byteLength).toBe(10);
    expect(truncated).toBe(false);
  });

  it("cuts at the limit and cancels the rest", async () => {
    let cancelled = false;
    const { bytes, truncated } = await readBounded(
      stream([4, 4, 4, 4], () => {
        cancelled = true;
      }),
      10,
    );
    expect([...bytes]).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3]);
    expect(truncated).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("cuts a single chunk larger than the whole limit", async () => {
    const { bytes, truncated } = await readBounded(stream([1000]), 16);
    expect(bytes.byteLength).toBe(16);
    expect(truncated).toBe(true);
  });

  it("reads no body as empty", async () => {
    expect(await readBounded(null, 10)).toEqual({ bytes: new Uint8Array(0), truncated: false });
  });

  it("reads a real Response body", async () => {
    const { bytes } = await readBounded(new Response("héllo").body, 100);
    expect(new TextDecoder().decode(bytes)).toBe("héllo");
  });
});
