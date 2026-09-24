import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { errorBoundary } from "./errors.ts";
import { apiSecureHeaders, corsAllowList } from "./headers.ts";

const APP = "https://app.example.com";

describe("apiSecureHeaders", () => {
  it("sets the headers a JSON API answers with", async () => {
    const app = new Hono().use(apiSecureHeaders()).get("/", (c) => c.json({ ok: true }));
    const { headers } = await app.request("/");
    expect(headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("adds a CSP directive without losing the defaults", async () => {
    const app = new Hono()
      .use(apiSecureHeaders({ contentSecurityPolicy: { formAction: ["'self'"] } }))
      .get("/", (c) => c.html("<form></form>"));
    const csp = (await app.request("/")).headers.get("Content-Security-Policy");
    expect(csp).toBe("default-src 'none'; frame-ancestors 'none'; form-action 'self'");
  });

  it("keeps its headers on a plain-object throw only if mounted before errorBoundary", async () => {
    function build(...middleware: MiddlewareHandler[]) {
      const app = new Hono();
      for (const handler of middleware) app.use(handler);
      app.onError((_err, c) => c.json({ error: "INTERNAL_ERROR" }, 500));
      return app.get("/", () => {
        // A PostgREST client rejects with objects like this one.
        throw Object.assign(Object.create(null), { code: "PGRST116" });
      });
    }
    const before = await build(apiSecureHeaders(), errorBoundary).request("/");
    expect(before.status).toBe(500);
    expect(before.headers.get("X-Content-Type-Options")).toBe("nosniff");

    // The order seven APIs in the fleet had: the 500 goes out bare.
    const after = await build(errorBoundary, apiSecureHeaders()).request("/");
    expect(after.status).toBe(500);
    expect(after.headers.get("X-Content-Type-Options")).toBeNull();
  });
});

describe("corsAllowList", () => {
  function app(...args: Parameters<typeof corsAllowList>) {
    return new Hono().use(corsAllowList(...args)).get("/", (c) => c.json({ ok: true }));
  }
  const from = (origin: string, init: RequestInit = {}) => ({
    ...init,
    headers: { Origin: origin, ...init.headers },
  });

  it("answers a listed origin, and no other, by exact match", async () => {
    const api = app([`${APP}/`]);
    const allowed = await api.request("/", from(APP));
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe(APP);
    expect(allowed.headers.get("Vary")).toBe("Origin");
    for (const stranger of [
      "https://app.example.com.evil.test",
      "https://evilapp.example.com",
      "https://evil.pages.dev",
      "http://app.example.com",
      "https://app.example.com:8443",
      "null",
    ])
      expect(
        (await api.request("/", from(stranger))).headers.get("Access-Control-Allow-Origin"),
      ).toBeNull();
  });

  it("lets a page read Retry-After and the request id, and sends no credentials flag", async () => {
    const answer = await app([APP], { exposeHeaders: ["X-Cache"] }).request("/", from(APP));
    expect(answer.headers.get("Access-Control-Expose-Headers")).toBe(
      "Retry-After,X-Request-ID,X-Cache",
    );
    expect(answer.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    const withCredentials = await app([APP], { credentials: true }).request("/", from(APP));
    expect(withCredentials.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("answers a preflight with the methods, and lets the browser keep it 10 minutes", async () => {
    const preflight = from(APP, {
      method: "OPTIONS",
      headers: { "Access-Control-Request-Method": "DELETE" },
    });
    const answer = await app([APP]).request("/", preflight);
    expect(answer.status).toBe(204);
    expect(answer.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
    expect(answer.headers.get("Access-Control-Max-Age")).toBe("600");
    const chosen = await app([APP], { allowMethods: ["GET"], maxAge: 60 }).request("/", preflight);
    expect(chosen.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    expect(chosen.headers.get("Access-Control-Max-Age")).toBe("60");
  });

  it("answers `has` the same way, for a door that reads Origin itself", () => {
    const origins = corsAllowList(["https://App.Example.com:443", " ", ""]);
    expect(origins.has(APP)).toBe(true);
    expect(origins.has(`${APP}.evil.test`)).toBe(false);
  });

  it("refuses at boot what is not an origin, and a list with none in it", () => {
    for (const entry of [
      "localhost:5173",
      "file:///",
      "*",
      `${APP}/app`,
      `${APP}?x=1`,
      "app.example.com",
    ])
      expect(() => corsAllowList([entry])).toThrow(
        `corsAllowList takes origins, such as "https://app.example.com", and "${entry}" is not one`,
      );
    expect(() => corsAllowList(["", "  "])).toThrow("has no origins");
  });
});
