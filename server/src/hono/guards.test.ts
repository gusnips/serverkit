import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { assertEveryRouteGuarded, guard } from "./guards.ts";

const requireAdmin = guard(async (c, next) => {
  if (c.req.header("Authorization") !== "Bearer admin") return c.json({}, 401);
  return next();
});

const logRequest: MiddlewareHandler = async (_c, next) => {
  await next();
};

const ok = (c: { text: (body: string) => Response }) => c.text("ok");

function check(app: Hono, publicPrefixes: string[] = []) {
  return () => assertEveryRouteGuarded(app, { publicPrefixes });
}

describe("assertEveryRouteGuarded", () => {
  it("passes an app whose guard is mounted before its routes", () => {
    const app = new Hono();
    app.use(logRequest);
    app.use("/admin/*", requireAdmin);
    app.get("/admin/users", ok);
    app.post("/admin/users/:id/ban", ok);

    expect(check(app)).not.toThrow();
  });

  it("fails a guard registered after its route, which matches it and never runs", async () => {
    // Compare pattern lists and this app is guarded: `/admin/*` covers `/admin/users`. Ask the
    // matcher and the handler comes first, answers, and the guard never runs.
    const app = new Hono();
    app.get("/admin/users", ok);
    app.use("/admin/*", requireAdmin);

    expect((await app.request("/admin/users")).status).toBe(200);
    expect(check(app)).toThrow(/endpoint\(s\) answer with no guard[^]*\n {2}GET \/admin\/users\n/);
  });

  it("fails a route with nothing in front of it but middleware that is not a guard", () => {
    const app = new Hono();
    app.use(logRequest);
    app.use("/admin/*", requireAdmin);
    app.get("/admin/users", ok);
    app.delete("/users/:id", ok);

    expect(check(app)).toThrow(/\n {2}DELETE \/users\/:id\n/);
    expect(check(app)).not.toThrow(/\/admin\/users/);
  });

  it("names every unguarded endpoint once, sorted", () => {
    const app = new Hono();
    app.post("/b", ok);
    app.get("/a", ok);
    app.get("/a", ok);

    expect(check(app)).toThrow(/2 endpoint\(s\)[^]*\n {2}GET \/a\n {2}POST \/b\n/);
  });

  it("exempts a public prefix and everything under it, and nothing that only starts with it", () => {
    const app = new Hono();
    app.post("/webhooks", ok);
    app.post("/webhooks/pay", ok);
    app.post("/webhooksx", ok);

    expect(check(app, ["/webhooks"])).toThrow(/\n {2}POST \/webhooksx\n/);
    expect(check(app, ["/webhooks"])).not.toThrow(/POST \/webhooks\n/);
  });

  it("counts a guard passed inline, ahead of the handler", () => {
    const app = new Hono();
    app.get("/me", requireAdmin, ok);

    expect(check(app)).not.toThrow();
  });

  it("checks an all() endpoint under every method, since every method reaches it", () => {
    // A protocol endpoint taking any method is written `app.all("/mcp", handle)`. A guard mounted
    // for POST alone leaves every other method reaching the handler bare.
    const guardedForAll = new Hono();
    guardedForAll.use("/mcp", requireAdmin);
    guardedForAll.all("/mcp", ok);

    const guardedForPost = new Hono();
    guardedForPost.post("/mcp", requireAdmin);
    guardedForPost.all("/mcp", ok);

    expect(check(guardedForAll)).not.toThrow();
    expect(check(guardedForPost)).toThrow(/\n {2}ALL \/mcp\n/);
  });

  it("sees through a sub-app, including one with its own onError", () => {
    // A sub-app with its own onError has every handler wrapped in a two-argument function, so an
    // endpoint in it reads as middleware unless the wrapper is looked through.
    const admin = new Hono();
    admin.onError((_err, c) => c.text("admin failed", 500));
    admin.get("/users", ok);

    const bare = new Hono();
    bare.route("/admin", admin);
    expect(check(bare)).toThrow(/\n {2}GET \/admin\/users\n/);

    const guardedInside = new Hono();
    guardedInside.use(requireAdmin);
    guardedInside.onError((_err, c) => c.text("admin failed", 500));
    guardedInside.get("/users", ok);
    const app = new Hono();
    app.route("/admin", guardedInside);
    expect(check(app)).not.toThrow();
  });

  it("fails a guard mounted in the parent after the sub-app it was meant for", () => {
    const admin = new Hono();
    admin.get("/users", ok);
    const app = new Hono();
    app.route("/admin", admin);
    app.use("/admin/*", requireAdmin);

    expect(check(app)).toThrow(/\n {2}GET \/admin\/users\n/);
  });

  it("reports a path it cannot build a request for, rather than passing it", () => {
    const app = new Hono();
    app.use("/files/*", requireAdmin);
    app.get("/files/:id{[0-9]+}", ok);

    expect(check(app)).toThrow(
      /GET \/files\/:id\{\[0-9\]\+\} \(could not be probed at \/files\/probe\)/,
    );
  });

  it("probes a wildcard endpoint", () => {
    const app = new Hono();
    app.get("/static/*", ok);
    app.get("*", ok);

    expect(check(app, ["/static"])).toThrow(/\n {2}GET \/\*\n/);
    expect(check(app, ["/static"])).not.toThrow(/static/);
  });
});

describe("guard", () => {
  it("returns the same function, so it can wrap one where it is defined", () => {
    const middleware: MiddlewareHandler = async (_c, next) => {
      await next();
    };

    expect(guard(middleware)).toBe(middleware);
  });
});
