import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bunPeer, clientIp, type ClientIpVariables } from "./client-ip.ts";

type AppEnv = { Variables: ClientIpVariables };

function appWith(middleware: ReturnType<typeof clientIp<AppEnv>>) {
  const app = new Hono<AppEnv>();
  app.use(middleware);
  app.get("/", (c) => c.json({ clientIp: c.get("clientIp") }));
  return app;
}

async function read(app: Hono<AppEnv>, init?: RequestInit) {
  return ((await (await app.request("/", init)).json()) as ClientIpVariables).clientIp;
}

describe("clientIp", () => {
  it("sets the address once, from the peer the runtime reports", async () => {
    const app = appWith(clientIp<AppEnv>({ peerOf: () => "127.0.0.1" }));
    const via = { headers: { "x-forwarded-for": "203.0.113.9" } };
    expect(await read(app, via)).toBe("203.0.113.9");
  });

  it("reads a peerOf that throws as no peer, so an in-process test request still runs", async () => {
    // hono/bun's getConnInfo throws for any request that did not come through Bun.serve.
    const app = appWith(
      clientIp<AppEnv>({
        peerOf: () => {
          throw new TypeError("c.env is not an Object");
        },
      }),
    );
    expect(await read(app)).toBeNull();
  });

  it("reads a platform header without asking for a peer", async () => {
    const app = appWith(clientIp<AppEnv>({ header: "cf-connecting-ip" }));
    expect(await read(app, { headers: { "cf-connecting-ip": "203.0.113.9" } })).toBe("203.0.113.9");
  });
});

describe("bunPeer", () => {
  // What Bun.serve hands fetch as its second argument, down to the one method bunPeer calls.
  // requestIP reads `this`, as Bun's does, so a call that loses the server fails here too.
  const bunServer = (address: string | null) => ({
    peers: new Map([["/", address]]),
    requestIP(this: { peers: Map<string, string | null> }, request: Request) {
      const peer = this.peers.get(new URL(request.url).pathname);
      return peer ? { address: peer, family: "IPv4", port: 51234 } : null;
    },
  });
  const app = appWith(clientIp<AppEnv>({ peerOf: bunPeer }));
  const via = { headers: { "x-forwarded-for": "203.0.113.9" } };

  it("reads the socket peer from the server Bun passes to fetch", async () => {
    expect(await body(await app.request("/", via, bunServer("198.51.100.4")))).toBe("198.51.100.4");
    expect(await body(await app.request("/", via, bunServer("127.0.0.1")))).toBe("203.0.113.9");
  });

  it("finds the server beside bindings, where hono/bun looks for it too", async () => {
    const env = { server: bunServer("198.51.100.4"), DATABASE_URL: "postgres://db" };
    expect(await body(await app.request("/", via, env))).toBe("198.51.100.4");
  });

  it("is no peer in a test's app.request and when Bun knows none", async () => {
    expect(await read(app, via)).toBeNull();
    expect(await body(await app.request("/", via, bunServer(null)))).toBeNull();
    expect(await body(await app.request("/", via, { requestIP: "not a function" }))).toBeNull();
  });
});

async function body(response: Response) {
  return ((await response.json()) as ClientIpVariables).clientIp;
}
