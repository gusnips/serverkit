import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { assertEveryRouteGuarded, guard, underAny } from "./guards.ts";

const requireAdmin = guard(async (c, next) => {
  if (c.req.header("Authorization") !== "Bearer admin") return c.json({}, 401);
  return next();
});

const logRequest: MiddlewareHandler = async (_c, next) => {
  await next();
};

const ok = (c: { text: (body: string) => Response }) => c.text("ok");

function check(app: Hono, isPublic: (path: string) => boolean = () => false) {
  return () => assertEveryRouteGuarded(app, { isPublic });
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

  it("fails a router mounted above the guard loop", async () => {
    // One backend's gate test built a second app from its guard list plus a catch-all, so it never
    // saw the real mount order, and passed while the real app's router, mounted above the loop,
    // answered with no token at all. Only the real app, asked, has the order.
    const patterns = ["/feedback", "/admin/*"];
    const feedback = new Hono();
    feedback.get("/", ok);
    feedback.post("/", ok);
    feedback.get("/mine", ok);
    const app = new Hono();
    app.route("/feedback", feedback);
    for (const pattern of patterns) app.use(pattern, requireAdmin);
    app.get("/admin/users", ok);

    expect((await app.request("/feedback/mine")).status).toBe(200);
    expect(check(app)).toThrow(
      /3 endpoint\(s\)[^]*\n {2}GET \/feedback\n {2}GET \/feedback\/mine\n {2}POST \/feedback\n/,
    );
  });

  it("fails the route under an exact guard pattern, which only ever covered itself", () => {
    // Hono reads `use("/feedback")` as that one path. The sub-route under it is what shipped public.
    const feedback = new Hono();
    feedback.get("/", ok);
    feedback.get("/mine", ok);
    const app = new Hono();
    app.use("/feedback", requireAdmin);
    app.route("/feedback", feedback);

    expect(check(app)).toThrow(/1 endpoint\(s\)[^]*\n {2}GET \/feedback\/mine\n/);
  });

  it("fails a guard that runs in front of no endpoint, which is what a router that mounted nothing leaves", () => {
    // A stand-in dependency's router registers nothing, so its routes drop out of the check, and
    // the check passes by having nothing to ask. The guard mounted over it is the trace left.
    const app = new Hono();
    app.use("/admin/*", requireAdmin);
    app.route("/admin", new Hono());
    app.get("/health", ok);

    expect(check(app, (path) => path === "/health")).toThrow(
      /1 guard\(s\) run in front of no endpoint:\n {2}ALL \/admin\/\*\n/,
    );
  });

  it("counts a guard in front of a route the app calls public, which the guard itself lets by", () => {
    // A guard that waves one public read through is still a guard with a route behind it.
    const app = new Hono();
    app.use("/sources/*", requireAdmin);
    app.get("/sources/catalog", ok);

    expect(check(app, (path) => path === "/sources/catalog")).not.toThrow();
  });

  it("fails an app with no endpoints at all, rather than passing it", () => {
    expect(check(new Hono())).toThrow(/no endpoints/);
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

  it("skips what the app's own rule calls public, asked with the path a request would carry", () => {
    const app = new Hono();
    app.post("/webhooks/pay", ok);
    app.get("/docs/:page", ok);
    app.get("/reports/:id{[0-9]+}", ok);
    const asked: string[] = [];
    const isPublic = (path: string) => {
      asked.push(path);
      return path.startsWith("/webhooks/") || path.startsWith("/docs/");
    };

    expect(check(app, isPublic)).toThrow(/1 endpoint\(s\)[^]*\n {2}GET \/reports\/:id/);
    expect(asked).toEqual(["/webhooks/pay", "/docs/probe", "/reports/1"]);
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

  it("probes a numeric parameter pattern with a number", () => {
    const app = new Hono();
    app.use("/forecasts/*", requireAdmin);
    app.get("/forecasts/:id{[0-9]+}/watch", ok);

    expect(check(app)).not.toThrow();
  });

  it("reports a path it cannot build a request for, rather than passing it", () => {
    const app = new Hono();
    app.use("/tags/*", requireAdmin);
    app.get("/tags/:name{[a-z]+}", ok);

    expect(check(app)).toThrow(
      /GET \/tags\/:name\{\[a-z\]\+\} \(could not be probed at \/tags\/1\)/,
    );
  });

  it("probes a wildcard endpoint", () => {
    const app = new Hono();
    app.get("/static/*", ok);
    app.get("*", ok);

    expect(check(app, underAny(["/static"]))).toThrow(/\n {2}GET \/\*\n/);
    expect(check(app, underAny(["/static"]))).not.toThrow(/static/);
  });
});

describe("underAny", () => {
  it("reads every entry as a prefix, whichever pattern form it is written in", () => {
    const under = underAny(["/feedback", "/admin/*"]);

    for (const path of ["/feedback", "/feedback/mine", "/admin", "/admin/users/1"])
      expect(under(path), path).toBe(true);
    for (const path of ["/feedbacks", "/adminx", "/", "/other/feedback"])
      expect(under(path), path).toBe(false);
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
