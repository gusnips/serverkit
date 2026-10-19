import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAppError, createErrorResponse, createLogger } from "../index.ts";
import { errorHandler } from "./errors.ts";
import { assertEveryRouteGuarded, guard, underAny } from "./guards.ts";
import type { RequestVariables } from "./request-logger.ts";
import {
  restRoutes,
  type RestRequest,
  type RestRoute,
  type RestRoutesOptions,
} from "./rest-routes.ts";

type ErrorCode = "VALIDATION_ERROR" | "UNAUTHORIZED" | "FORBIDDEN" | "TOO_LARGE" | "INTERNAL_ERROR";
type AppEnv = { Variables: RequestVariables<ErrorCode> };

const appError = createAppError({
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
} as const);

const errorResponse = createErrorResponse<ErrorCode, string>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
});

const options: RestRoutesOptions = {
  bodyLimit: 64,
  tooLarge: (maxBytes) => appError("TOO_LARGE", `The body is over ${maxBytes} bytes`),
  invalidBody: (reason) => appError("VALIDATION_ERROR", `The body is ${reason}`),
};

/** The door a protected route runs behind: a request with no `x-key` is refused. */
const requireKey: MiddlewareHandler<AppEnv> = guard(async (c, next) => {
  if (!c.req.header("x-key")) throw appError("UNAUTHORIZED", "Send your API key");
  await next();
});

/** A route that answers with what it was handed, and remembers it. */
function echo(
  method: RestRoute["method"],
  path: `/${string}`,
  extra: Partial<RestRoute<AppEnv>> = {},
) {
  const seen: RestRequest[] = [];
  const route: RestRoute<AppEnv> = {
    method,
    path,
    run: async (_c, request) => {
      seen.push(request);
      return { data: request };
    },
    ...extra,
  };
  return { route, seen };
}

function appWith(routes: RestRoute<AppEnv>[], overrides: Partial<RestRoutesOptions> = {}) {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler({ errorResponse, logger: createLogger({ write: () => {} }) }));
  app.route("/v1", restRoutes(routes, { ...options, ...overrides }));
  return app;
}

const post = (body: RequestInit["body"], headers: Record<string, string> = {}) => ({
  method: "POST",
  body,
  headers: { "content-type": "application/json", ...headers },
});

describe("restRoutes: where the input comes from", () => {
  it("reads a GET's query, with a repeated name as a list, and the path's ids apart", async () => {
    const { route } = echo("get", "/things/:id");
    const res = await appWith([route]).request("/v1/things/7?id=other&tag=a&tag=b&q=x");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { params: { id: "7" }, input: { id: "other", tag: ["a", "b"], q: "x" } },
    });
  });

  it("reads a DELETE's query and never its body, as the reference documents it", async () => {
    const { route } = echo("delete", "/things/:id");
    const res = await appWith([route]).request("/v1/things/7?reason=dupe", {
      method: "DELETE",
      body: "{ not json",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { params: { id: "7" }, input: { reason: "dupe" } } });
  });

  it.each(["post", "put", "patch"] as const)(
    "reads a %s's JSON object body, with the path's ids apart",
    async (method) => {
      const { route } = echo(method, "/things/:id");
      const res = await appWith([route]).request("/v1/things/7?q=ignored", {
        ...post(JSON.stringify({ id: "body", n: 1 })),
        method: method.toUpperCase(),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        data: { params: { id: "7" }, input: { id: "body", n: 1 } },
      });
    },
  );

  it.each(["", "  \n "])("reads an empty body as {}", async (body) => {
    const { route } = echo("post", "/things");
    const res = await appWith([route]).request("/v1/things", post(body));
    expect(await res.json()).toEqual({ data: { params: {}, input: {} } });
  });

  it.each(["{", "{'a':1}", '{"a":1,}', "a=1&b=2"])(
    "refuses %j as malformed, and never runs the operation",
    async (body) => {
      const { route, seen } = echo("post", "/things");
      const res = await appWith([route]).request("/v1/things", post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { message: "The body is malformed" } });
      expect(seen).toHaveLength(0);
    },
  );

  it.each(['"text"', "42", "[1,2]", "null", "true"])(
    "refuses %s as not an object, and never runs the operation",
    async (body) => {
      const { route, seen } = echo("post", "/things");
      const res = await appWith([route]).request("/v1/things", post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: { message: "The body is not-an-object" } });
      expect(seen).toHaveLength(0);
    },
  );
});

describe("restRoutes: who runs first", () => {
  it("runs `before` ahead of the body, so a stranger is refused before the body is judged", async () => {
    const { route, seen } = echo("post", "/things", { before: [requireKey] });
    const app = appWith([route]);
    expect((await app.request("/v1/things", post("{ not json"))).status).toBe(401);
    expect(
      (await app.request("/v1/things", post(JSON.stringify({ pad: "x".repeat(200) })))).status,
    ).toBe(401);
    expect((await app.request("/v1/things", post("{ not json", { "x-key": "k" }))).status).toBe(
      400,
    );
    expect(seen).toHaveLength(0);
  });

  it("validates nothing, so the operation refuses a caller before its schema speaks", async () => {
    const schema = z.object({ name: z.string().min(1) }).strict();
    const route: RestRoute<AppEnv> = {
      method: "post",
      path: "/things",
      run: async (c, { input }) => {
        if (c.req.header("x-role") !== "admin") throw appError("FORBIDDEN", "Admins only");
        return { data: schema.parse(input) };
      },
    };
    const app = appWith([route]);
    const invalid = post(JSON.stringify({ name: "", extra: true }));
    expect((await app.request("/v1/things", invalid)).status).toBe(403);
    const asAdmin = post(JSON.stringify({ name: "", extra: true }), { "x-role": "admin" });
    expect((await app.request("/v1/things", asAdmin)).status).toBe(400);
  });

  it("lets the guard check see a protected route that forgot its door", () => {
    const open = echo("get", "/health").route;
    const guarded = echo("get", "/things", { before: [requireKey] }).route;
    const isPublic = underAny(["/v1/health"]);
    expect(() => assertEveryRouteGuarded(appWith([open, guarded]), { isPublic })).not.toThrow();
    const forgot = echo("post", "/things").route;
    expect(() => assertEveryRouteGuarded(appWith([open, guarded, forgot]), { isPublic })).toThrow(
      "POST /v1/things",
    );
  });
});

describe("restRoutes: the body limit", () => {
  it("answers a body over the list's limit with the product's 413", async () => {
    const { route, seen } = echo("post", "/things");
    const res = await appWith([route]).request(
      "/v1/things",
      post(JSON.stringify({ pad: "x".repeat(80) })),
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { message: "The body is over 64 bytes" } });
    expect(seen).toHaveLength(0);
  });

  it("measures a chunked body too, which carries no length to read first", async () => {
    const { route, seen } = echo("post", "/things");
    const chunk = new TextEncoder().encode(JSON.stringify({ pad: "x".repeat(80) }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    // A stream body needs `duplex` on Node, and the DOM's RequestInit does not declare it yet.
    const init: RequestInit & { duplex: "half" } = { ...post(body), duplex: "half" };
    const res = await appWith([route]).request("/v1/things", init);
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it("takes a route's own limit over the list's", async () => {
    const { route } = echo("post", "/files", { bodyLimit: 1024 });
    const res = await appWith([route]).request(
      "/v1/files",
      post(JSON.stringify({ pad: "x".repeat(200) })),
    );
    expect(res.status).toBe(200);
  });
});

describe("restRoutes: the answer", () => {
  it.each([201, 202] as const)("answers %i with the envelope", async (status) => {
    const route: RestRoute<AppEnv> = {
      method: "post",
      path: "/jobs",
      status,
      run: async () => ({ data: { id: "j1" } }),
    };
    const res = await appWith([route]).request("/v1/jobs", post(""));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ data: { id: "j1" } });
  });

  it("answers 204 with no body and no content-type, even when the operation returned data", async () => {
    const route: RestRoute<AppEnv> = {
      method: "delete",
      path: "/things/:id",
      status: 204,
      run: async () => ({ data: { deleted: true } }),
    };
    const res = await appWith([route]).request("/v1/things/7", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
  });

  it("puts `meta` beside `data` only when there is one", async () => {
    const metered: RestRoute<AppEnv> = {
      method: "get",
      path: "/a",
      run: async () => ({ data: 1, meta: { cost: 2 } }),
    };
    const plain: RestRoute<AppEnv> = { method: "get", path: "/b", run: async () => ({ data: 1 }) };
    const app = appWith([metered, plain]);
    expect(await (await app.request("/v1/a")).json()).toEqual({ data: 1, meta: { cost: 2 } });
    expect(await (await app.request("/v1/b")).json()).toEqual({ data: 1 });
  });

  it("keeps a header the operation set when it then refuses, as on success", async () => {
    const route: RestRoute<AppEnv> = {
      method: "get",
      path: "/pages/:id",
      run: async (c, { params }) => {
        try {
          if (params.id === "blocked") throw appError("FORBIDDEN", "That page is blocked");
          return { data: params.id };
        } finally {
          c.header("x-cost", "0");
        }
      },
    };
    const app = appWith([route]);
    const refused = await app.request("/v1/pages/blocked");
    expect(refused.status).toBe(403);
    expect(refused.headers.get("x-cost")).toBe("0");
    expect((await app.request("/v1/pages/ok")).headers.get("x-cost")).toBe("0");
  });
});

describe("restRoutes: the list", () => {
  it("refuses one method and path twice, and allows one path under two methods", () => {
    const first = echo("get", "/things/:id").route;
    expect(() => restRoutes([first, echo("get", "/things/:id").route], options)).toThrow(
      "GET /things/:id is in the list twice",
    );
    expect(() => restRoutes([first, echo("delete", "/things/:id").route], options)).not.toThrow();
  });

  it("hands the operation the request's own signal, so a hang-up can stop the work", async () => {
    const signals: AbortSignal[] = [];
    const route: RestRoute<AppEnv> = {
      method: "get",
      path: "/slow",
      run: async (c) => {
        signals.push(c.req.raw.signal);
        return { data: null };
      },
    };
    const controller = new AbortController();
    await appWith([route]).request("/v1/slow", { signal: controller.signal });
    controller.abort();
    expect(signals[0]?.aborted).toBe(true);
  });
});
