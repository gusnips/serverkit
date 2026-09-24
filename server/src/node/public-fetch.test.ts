/**
 * Every test here dials a real local server. The names are made up and resolved by an injected
 * resolver, so a name can point at loopback (with `allowLoopback`) or at a private address without
 * touching DNS, and nothing leaves the machine.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createTlsServer, globalAgent } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { TLSSocket } from "node:tls";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readBounded } from "../url-guard.ts";
import { fetchPublic, pinnedRequest, resolvePublic, type Resolve } from "./public-fetch.ts";

const local = { schemes: ["http:", "https:"], allowLoopback: true } as const;
const seconds = (n: number) => AbortSignal.timeout(n * 1000);

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: string;
}
const seen: Seen[] = [];
const hits = (path: string) => seen.filter((request) => request.path === path).length;

let port = 0;
const routes: Record<string, (res: ServerResponse) => void> = {
  "/hello": (res) => {
    res.setHeader("set-cookie", ["a=1", "b=2"]);
    res.end("hello");
  },
  "/echo": (res) => res.end("echoed"),
  "/gzip": (res) => {
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync("decoded from gzip"));
  },
  "/br": (res) => {
    res.setHeader("content-encoding", "br");
    res.end(brotliCompressSync("decoded from brotli"));
  },
  // Ten megabytes of zeros is about ten kilobytes on the wire.
  "/bomb": (res) => {
    res.setHeader("content-encoding", "gzip");
    res.end(gzipSync(new Uint8Array(10_000_000)));
  },
  "/204": (res) => {
    res.statusCode = 204;
    res.end();
  },
  "/gzip-half": (res) => {
    res.setHeader("content-encoding", "gzip");
    res.write(gzipSync(new Uint8Array(100_000).fill(1)).subarray(0, 64));
  },
  "/hang": () => undefined,
  "/half": (res) => res.write("first"),
  "/reset": (res) => res.socket?.destroy(),
  "/to-other": (res) => redirect(res, 302, `http://other.example.test:${port}/landed`),
  "/to-self": (res) => redirect(res, 302, "/to-self"),
  "/to-metadata": (res) => redirect(res, 302, "http://169.254.169.254/latest/meta-data/"),
  "/to-internal": (res) => redirect(res, 302, `http://internal.example.test:${port}/`),
  "/post-302": (res) => redirect(res, 302, "/landed"),
  "/landed": (res) => res.end("landed"),
};

function redirect(res: ServerResponse, status: number, location: string): void {
  res.statusCode = status;
  res.setHeader("location", location);
  res.end();
}

const names: Record<string, string[]> = {
  "hooks.example.test": ["127.0.0.1"],
  "other.example.test": ["127.0.0.1"],
  "internal.example.test": ["10.0.0.5"],
};
const asked: string[] = [];
const resolve: Resolve = async (host) => {
  asked.push(host);
  return names[host] ?? [];
};

let server: Server;
beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      seen.push({ method: req.method ?? "", path, headers: req.headers, body });
      (routes[path] ?? ((r: ServerResponse) => r.end()))(res);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.closeAllConnections();
  server.close();
});
beforeEach(() => {
  seen.length = 0;
  asked.length = 0;
});

const at = (path: string, host = "hooks.example.test") => ({
  url: new URL(`http://${host}:${port}${path}`),
  addresses: ["127.0.0.1"],
});

describe("resolvePublic", () => {
  it("answers every address, IPv4 first, when every answer is public", async () => {
    const answers = ["2606:4700::1111", "1.1.1.1", "2606:4700::1001", "1.0.0.1"];
    const result = await resolvePublic("https://cdn.example.com/", {
      signal: seconds(1),
      resolve: async () => answers,
    });
    expect(result).toMatchObject({
      ok: true,
      addresses: ["1.1.1.1", "1.0.0.1", "2606:4700::1111", "2606:4700::1001"],
    });
  });

  it("refuses the whole name when any answer is private", async () => {
    const result = await resolvePublic("https://mixed.example.com/", {
      signal: seconds(1),
      resolve: async () => ["1.1.1.1", "10.0.0.1"],
    });
    expect(result).toEqual({ ok: false, reason: "private-address" });
  });

  it("asks nobody about an address", async () => {
    const result = await resolvePublic("https://1.1.1.1/", {
      signal: seconds(1),
      resolve: () => Promise.reject(new Error("must not be asked")),
    });
    expect(result).toMatchObject({ ok: true, addresses: ["1.1.1.1"] });
  });

  it("calls a name DNS does not know unresolvable", async () => {
    const notFound = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    for (const answer of [() => Promise.reject(notFound), async () => []]) {
      const result = await resolvePublic("https://nothing.example.com/", {
        signal: seconds(1),
        resolve: answer,
      });
      expect(result).toEqual({ ok: false, reason: "unresolvable" });
    }
  });

  it("throws when DNS fails to answer, rather than blaming the customer's host", async () => {
    const down = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    await expect(
      resolvePublic("https://api.example.com/", {
        signal: seconds(1),
        resolve: () => Promise.reject(down),
      }),
    ).rejects.toBe(down);
  });

  it("stops waiting for DNS when the signal fires", async () => {
    await expect(
      resolvePublic("https://slow.example.com/", {
        signal: AbortSignal.timeout(50),
        resolve: () => new Promise<never>(() => undefined),
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("passes a shape refusal through", async () => {
    expect(await resolvePublic("http://example.com/", { signal: seconds(1) })).toEqual({
      ok: false,
      reason: "scheme",
    });
  });

  it("asks the system resolver by default", async () => {
    const result = await resolvePublic("http://localhost:1/", {
      signal: seconds(2),
      policy: local,
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.ok && result.addresses[0]).toBe("127.0.0.1");
  });
});

describe("pinnedRequest", () => {
  it("dials the address, names the host, and answers with a real Response", async () => {
    const target = at("/hello?x=1");
    const response = await pinnedRequest(target, { signal: seconds(2) });
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello");
    expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(seen[0]).toMatchObject({ path: "/hello" });
    expect(seen[0]?.headers.host).toBe(`hooks.example.test:${port}`);
  });

  it("sends a body with its length rather than chunked", async () => {
    const response = await pinnedRequest(at("/echo"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"é":1}',
      signal: seconds(2),
    });
    await response.body?.cancel();
    expect(seen[0]?.headers["content-length"]).toBe("8");
    expect(seen[0]?.headers["transfer-encoding"]).toBeUndefined();
    expect(seen[0]?.body).toBe('{"é":1}');
  });

  it("tries the next address when one refuses the connection", async () => {
    // Nothing listens on ::1 at this port, so that connect is refused before a byte is sent.
    const target = { ...at("/hello"), addresses: ["::1", "127.0.0.1"] };
    const response = await pinnedRequest(target, { signal: seconds(2) });
    expect(await response.text()).toBe("hello");
  });

  it("does not try another address once one accepted the request", async () => {
    const target = { ...at("/reset"), addresses: ["127.0.0.1", "127.0.0.1"] };
    await expect(pinnedRequest(target, { signal: seconds(2) })).rejects.toThrow();
    expect(hits("/reset")).toBe(1);
  });

  it("stops at the deadline and does not try another address", async () => {
    const target = { ...at("/hang"), addresses: ["127.0.0.1", "127.0.0.1"] };
    await expect(pinnedRequest(target, { signal: AbortSignal.timeout(100) })).rejects.toMatchObject(
      { name: "TimeoutError" },
    );
    expect(hits("/hang")).toBe(1);
  });

  it("fails a body read cut off by the deadline with the signal's reason", async () => {
    const response = await pinnedRequest(at("/half"), { signal: AbortSignal.timeout(150) });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
    await expect(reader.read()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("fails a compressed body cut off by the deadline, rather than ending it early", async () => {
    const response = await pinnedRequest(at("/gzip-half"), { signal: AbortSignal.timeout(150) });
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("decodes gzip and brotli, and drops the headers that described the wire", async () => {
    for (const [path, text] of [
      ["/gzip", "decoded from gzip"],
      ["/br", "decoded from brotli"],
    ] as const) {
      const response = await pinnedRequest(at(path), { signal: seconds(2) });
      expect(await response.text()).toBe(text);
      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
    }
  });

  it("lets readBounded count decoded bytes, so a small bomb cannot fill memory", async () => {
    const response = await pinnedRequest(at("/bomb"), { signal: seconds(2) });
    const { bytes, truncated } = await readBounded(response.body, 1_000);
    expect(bytes.byteLength).toBe(1_000);
    expect(truncated).toBe(true);
  });

  it("gives a 204 and a HEAD no body", async () => {
    const empty = await pinnedRequest(at("/204"), { signal: seconds(2) });
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    const head = await pinnedRequest(at("/hello"), { method: "HEAD", signal: seconds(2) });
    expect(head.body).toBeNull();
  });
});

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasOpenssl)("pinnedRequest over TLS", () => {
  let tls: Server;
  let tlsPort = 0;
  let dir = "";
  const sni: unknown[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "public-fetch-tls-"));
    const openssl = (...args: string[]) =>
      execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
    writeFileSync(
      join(dir, "leaf.cnf"),
      "[req]\ndistinguished_name=dn\n[dn]\n[ext]\nsubjectAltName=DNS:hooks.example.test\n",
    );
    openssl(
      ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem"],
      ...["-days", "1", "-subj", "/CN=test-ca", "-addext", "basicConstraints=critical,CA:TRUE"],
      ...["-addext", "keyUsage=critical,keyCertSign"],
    );
    openssl(
      ...["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr"],
      ...["-subj", "/CN=hooks.example.test"],
    );
    openssl(
      ...["x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key"],
      ...["-CAcreateserial", "-out", "leaf.pem", "-days", "1"],
      ...["-extfile", "leaf.cnf", "-extensions", "ext"],
    );
    // The dial goes through the default agent, so this is how a test trusts its own CA.
    globalAgent.options.ca = readFileSync(join(dir, "ca.pem"));
    tls = createTlsServer(
      { key: readFileSync(join(dir, "leaf.key")), cert: readFileSync(join(dir, "leaf.pem")) },
      (req, res) => {
        sni.push(req.socket instanceof TLSSocket ? req.socket.servername : false);
        res.end("secure");
      },
    );
    await new Promise<void>((done) => tls.listen(0, "127.0.0.1", done));
    tlsPort = (tls.address() as AddressInfo).port;
  });
  afterAll(() => {
    delete globalAgent.options.ca;
    tls.closeAllConnections();
    tls.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // One address, two names. If the certificate were checked against the address, both would
  // fail, because it names no address; if it were not checked, both would pass.
  it("checks the certificate against the name, not the address it dialled", async () => {
    const response = await pinnedRequest(
      { url: new URL(`https://hooks.example.test:${tlsPort}/`), addresses: ["127.0.0.1"] },
      { signal: seconds(2) },
    );
    expect(await response.text()).toBe("secure");
    expect(sni).toEqual(["hooks.example.test"]);

    await expect(
      pinnedRequest(
        { url: new URL(`https://other.example.test:${tlsPort}/`), addresses: ["127.0.0.1"] },
        { signal: seconds(2) },
      ),
    ).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });
});

describe("fetchPublic", () => {
  const base = (path: string) => `http://hooks.example.test:${port}${path}`;

  it("follows a redirect to another origin, resolving it again and leaving credentials behind", async () => {
    const result = await fetchPublic(base("/to-other"), {
      headers: { authorization: "Bearer t", cookie: "s=1", "x-trace": "abc" },
      policy: local,
      resolve,
      signal: seconds(2),
    });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(await result.response.text()).toBe("landed");
    expect(result.url.hostname).toBe("other.example.test");
    expect(result.redirects).toBe(1);
    expect(asked).toEqual(["hooks.example.test", "other.example.test"]);
    const landed = seen.find((request) => request.path === "/landed");
    expect(landed?.headers.authorization).toBeUndefined();
    expect(landed?.headers.cookie).toBeUndefined();
    expect(landed?.headers["x-trace"]).toBe("abc");
    expect(landed?.headers.host).toBe(`other.example.test:${port}`);
  });

  it("sends a POST answered by 302 on as a GET with no body", async () => {
    const result = await fetchPublic(base("/post-302"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      policy: local,
      resolve,
      signal: seconds(2),
    });
    expect(result.ok).toBe(true);
    const landed = seen.find((request) => request.path === "/landed");
    expect(landed).toMatchObject({ method: "GET", body: "" });
    expect(landed?.headers["content-type"]).toBeUndefined();
  });

  // The hop is refused before anything is sent to it. A dial to 10.0.0.5 would hang until the
  // deadline and throw; a refusal can only come back if the dial never happened.
  it("refuses a redirect toward a private address without sending it", async () => {
    for (const path of ["/to-metadata", "/to-internal"]) {
      const result = await fetchPublic(base(path), { policy: local, resolve, signal: seconds(2) });
      expect(result).toEqual({ ok: false, reason: "private-address" });
    }
  });

  it("follows nothing at maxRedirects 0, and hands the redirect back", async () => {
    const result = await fetchPublic(base("/to-other"), {
      maxRedirects: 0,
      policy: local,
      resolve,
      signal: seconds(2),
    });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.response.status).toBe(302);
    expect(result.redirects).toBe(0);
    expect(hits("/landed")).toBe(0);
  });

  it("refuses a redirect loop past the limit", async () => {
    const result = await fetchPublic(base("/to-self"), {
      maxRedirects: 3,
      policy: local,
      resolve,
      signal: seconds(2),
    });
    expect(result).toEqual({ ok: false, reason: "too-many-redirects" });
    expect(hits("/to-self")).toBe(4);
  });
});
