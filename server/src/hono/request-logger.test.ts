import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger/index.ts";
import {
  requestLogger,
  type RequestLoggerOptions,
  type RequestVariables,
} from "./request-logger.ts";

function setup<E extends { Variables: RequestVariables } = { Variables: RequestVariables }>(
  options: Omit<RequestLoggerOptions<E>, "logger"> = {},
) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const app = new Hono<E>();
  app.use(requestLogger<E>({ logger, ...options }));
  return { app, lines };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type AppEnv = {
  Variables: RequestVariables<"DENIED"> & { actorId: string };
};

describe("the request line", () => {
  it("adds typed adopter fields after the response exists", async () => {
    const { app, lines } = setup<AppEnv>({
      fields: (c) => ({ actorId: c.get("actorId"), responseStatus: c.res.status }),
    });
    app.post("/items", (c) => {
      c.set("actorId", "user_1");
      return c.text("created", 201);
    });

    await app.request("/items", { method: "POST" });

    expect(lines[0]).toMatchObject({ actorId: "user_1", responseStatus: 201 });
  });

  it("keeps every canonical request field when adopter fields use the same names", async () => {
    const { app, lines } = setup<AppEnv>({
      fields: () => ({
        actorId: "user_1",
        requestId: "wrong",
        method: "DELETE",
        route: "/wrong",
        status: 599,
        ms: -1,
        errorCode: "WRONG",
      }),
    });
    app.post("/items/:id", (c) => {
      c.set("errorCode", "DENIED");
      return c.text("no", 403);
    });

    await app.request("/items/secret", {
      method: "POST",
      headers: { "X-Request-ID": "trace_1" },
    });

    expect(lines[0]).toMatchObject({
      actorId: "user_1",
      requestId: "trace_1",
      method: "POST",
      route: "/items/:id",
      status: 403,
      errorCode: "DENIED",
    });
    expect(lines[0]!.ms).not.toBe(-1);
  });

  it("does not let a broken adopter field hook lose the response or its request line", async () => {
    const { app, lines } = setup<AppEnv>({
      fields: () => {
        throw new Error("field hook broke");
      },
    });
    app.get("/items", (c) => c.text("ok"));

    const response = await app.request("/items");

    expect(response.status).toBe(200);
    expect(lines[0]).toMatchObject({
      requestFieldsFailed: true,
      method: "GET",
      route: "/items",
      status: 200,
    });
  });

  it("names the route template, never the path", async () => {
    // A path carries whatever the caller put in it. In one backend that was a customer's national
    // id number, and the request line carried it into the log and on into an analytics event.
    const { app, lines } = setup();
    app.get("/people/:taxId/export", (c) => c.text("ok"));

    await app.request("/people/12345678900/export");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ method: "GET", route: "/people/:taxId/export", status: 200 });
    expect(JSON.stringify(lines)).not.toContain("12345678900");
  });

  it("names the route a refused request was headed for, not the middleware that refused it", async () => {
    // The last matched route, not the deepest one that ran: a 401 from an auth middleware is
    // filed under the endpoint it protected, which is the thing anyone reading the log asks about.
    const { app, lines } = setup();
    app.use("/admin/*", (c) => Promise.resolve(c.json({}, 401)));
    app.get("/admin/users/:id", (c) => c.text("ok"));

    await app.request("/admin/users/7");

    expect(lines[0]).toMatchObject({ route: "/admin/users/:id", status: 401 });
  });

  it("does not write an unmatched path either", async () => {
    const { app, lines } = setup();

    await app.request("/wp-admin/12345678900.php");

    expect(lines[0]).toMatchObject({ status: 404 });
    expect(JSON.stringify(lines)).not.toContain("12345678900");
  });

  it("carries the refusal's code, rather than a second line of its own", async () => {
    // A wrong code, a spent quota and a scanner's junk key are all routine. One warn per event
    // would bury the failures that need a human, so the code rides on the line that exists anyway.
    const { app, lines } = setup();
    app.get("/verify", (c) => {
      c.set("errorCode", "CODE_MISMATCH");
      return c.json({}, 400);
    });
    app.get("/fine", (c) => c.text("ok"));

    await app.request("/verify");
    await app.request("/fine");

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ level: "info", status: 400, errorCode: "CODE_MISMATCH" });
    expect(lines[1]).not.toHaveProperty("errorCode");
  });

  it("starts errorCode at null, as its type says, rather than undefined", async () => {
    const { app } = setup();
    app.get("/", (c) => c.json({ errorCode: c.get("errorCode") }));

    expect(await (await app.request("/")).json()).toEqual({ errorCode: null });
  });

  it("is still written for a request whose throw escaped every handler", async () => {
    // Hono hands onError only an `Error`. A plain object — which is what a PostgREST client
    // rejects with — is rethrown past every layer, and without a catch here the request that
    // most needed a line is the one that never gets one.
    const { app, lines } = setup();
    app.get("/rows", () => {
      throw { code: "PGRST116", message: "no rows" };
    });

    await expect(app.request("/rows")).rejects.toMatchObject({ code: "PGRST116" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "error", route: "/rows", status: 500 });
    expect(lines[0]!.error).toMatchObject({ code: "PGRST116" });
  });
});

describe("what is not logged", () => {
  it("skips /health and anything under it, but not a path that only starts with the word", async () => {
    const { app, lines } = setup();
    for (const path of ["/health", "/health/db", "/healthz"]) app.get(path, (c) => c.text("ok"));

    for (const path of ["/health", "/health/db", "/healthz"]) await app.request(path);

    expect(lines.map((line) => line.route)).toEqual(["/healthz"]);
  });

  it("skips a preflight", async () => {
    const { app, lines } = setup();
    app.options("/items", (c) => c.body(null, 204));

    await app.request("/items", { method: "OPTIONS" });

    expect(lines).toEqual([]);
  });

  it("takes your own list in place of /health", async () => {
    const { app, lines } = setup({ skipPaths: ["/ready"] });
    app.get("/ready", (c) => c.text("ok"));
    app.get("/health", (c) => c.text("ok"));

    await app.request("/ready");
    await app.request("/health");

    expect(lines.map((line) => line.route)).toEqual(["/health"]);
  });

  it("still logs a skipped path that threw", async () => {
    // Skipping is about volume. A health check that throws is not routine.
    const { app, lines } = setup();
    app.get("/health", () => {
      throw { message: "pool exhausted" };
    });

    await expect(app.request("/health")).rejects.toMatchObject({ message: "pool exhausted" });

    expect(lines[0]).toMatchObject({ level: "error", status: 500 });
  });
});

describe("the request id", () => {
  it("echoes a well-formed id the caller sent, and logs it", async () => {
    const { app, lines } = setup();
    app.get("/", (c) => c.text(c.get("requestId")));

    const res = await app.request("/", { headers: { "X-Request-ID": "trace-2f9A_b.7" } });

    expect(res.headers.get("X-Request-ID")).toBe("trace-2f9A_b.7");
    expect(await res.text()).toBe("trace-2f9A_b.7");
    expect(lines[0]).toMatchObject({ requestId: "trace-2f9A_b.7" });
  });

  it.each([
    ["longer than 64 characters", "a".repeat(65)],
    ["eight kilobytes long", "a".repeat(8192)],
    ["carrying a space", "trace 1"],
    ["carrying JSON", '{"admin":true}'],
    ["carrying a character outside ASCII", "trace-ï"],
  ])("replaces one %s with a fresh id, rather than echoing it", async (_, supplied) => {
    const { app, lines } = setup();
    app.get("/", (c) => c.text("ok"));

    const res = await app.request("/", { headers: { "X-Request-ID": supplied } });

    expect(res.headers.get("X-Request-ID")).toMatch(UUID);
    expect(lines[0]!.requestId).toBe(res.headers.get("X-Request-ID"));
    expect(JSON.stringify(lines)).not.toContain(supplied);
  });

  it("mints one when the caller sent none", async () => {
    const { app } = setup();
    app.get("/", (c) => c.text("ok"));

    const res = await app.request("/");

    expect(res.headers.get("X-Request-ID")).toMatch(UUID);
  });

  it("is on the answer even when the handler built its own Response", async () => {
    // A header set before `next()` lives on a draft that Hono drops when a handler returns a
    // Response it built itself, unless something else happened to materialize the draft first.
    const { app } = setup();
    app.get("/raw", () => new Response("ok"));

    const res = await app.request("/raw");

    expect(res.headers.get("X-Request-ID")).toMatch(UUID);
  });

  it("is on a skipped path's answer too", async () => {
    const { app } = setup();
    app.get("/health", (c) => c.text("ok"));

    const res = await app.request("/health");

    expect(res.headers.get("X-Request-ID")).toMatch(UUID);
  });
});
