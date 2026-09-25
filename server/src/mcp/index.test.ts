import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAppError } from "../errors.ts";
import { createErrorResponse } from "../responses.ts";
import {
  mcpRoutes,
  registerOperation,
  toolError,
  type ToolDoor,
  type ToolOperation,
} from "./index.ts";

type Code =
  | "NOT_FOUND"
  | "RATE_LIMIT_EXCEEDED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "VALIDATION_ERROR";
const appError = createAppError({
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
  VALIDATION_ERROR: 400,
} as const);
const errorResponse = createErrorResponse<Code, string>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
});

interface Deps {
  userId: string;
}

const getPlace: ToolOperation<Deps, { id: string; limit: number }, { id: string; owner: string }> =
  {
    name: "get_place",
    description: "Reads one place.",
    inputSchema: z.object({ id: z.string(), limit: z.number().max(10).default(5) }).strict(),
    annotations: { readOnlyHint: true },
    async run(deps, args) {
      if (args.id === "missing") throw appError("NOT_FOUND", "Place not found");
      if (args.id === "down")
        throw appError("SERVICE_UNAVAILABLE", "Maps is down, try in a minute");
      if (args.id === "bug") throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (db.internal)");
      return { id: args.id, owner: deps.userId };
    },
  };

interface LogLine {
  message: string;
  meta?: Record<string, unknown>;
}

function harness(overrides: Partial<ToolDoor<Deps>> = {}) {
  const logs: LogLine[] = [];
  const unexpected: string[] = [];
  const counted: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message: string, meta?: Record<string, unknown>) => void logs.push({ message, meta }),
  };
  const door: ToolDoor<Deps> = {
    errorResponse,
    logger,
    requestId: "req_1",
    deps: () => ({ userId: "u_1" }),
    beforeCall: (tool) => void counted.push(tool),
    onUnexpected: (_err, tool) => void unexpected.push(tool),
    ...overrides,
  };
  const built: McpServer[] = [];
  const app = new Hono().route(
    "/",
    mcpRoutes(
      "/mcp",
      () => {
        const server = new McpServer({ name: "test", version: "0.0.0" });
        registerOperation(server, getPlace, door);
        built.push(server);
        return server;
      },
      { allowedOrigins: new Set(["https://app.acme.test"]) },
    ),
  );
  return { app, logs, unexpected, counted, built };
}

const HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": "2025-06-18",
};

const call = (id: number, args: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "get_place", arguments: args },
});

async function post(
  app: Hono,
  body: unknown,
  init: { path?: string; headers?: Record<string, string> } = {},
) {
  const res = await app.request(init.path ?? "/mcp", {
    method: "POST",
    headers: { ...HEADERS, ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { res, json: (await res.json()) as unknown };
}

/** The tool result of a single call: its JSON body, and whether it is an error. */
async function callTool(app: Hono, args: Record<string, unknown>) {
  const { json } = await post(app, call(1, args));
  const { result } = json as { result: { content: { text: string }[]; isError?: boolean } };
  const text = result.content[0]!.text;
  return {
    isError: result.isError === true,
    text,
    body: text.startsWith("{") ? (JSON.parse(text) as unknown) : text,
  };
}

describe("registerOperation", () => {
  it("answers the REST body, { data }, with the args the schema parsed", async () => {
    const { app, counted } = harness();
    expect(await callTool(app, { id: "p_1" })).toEqual({
      isError: false,
      text: '{"data":{"id":"p_1","owner":"u_1"}}',
      body: { data: { id: "p_1", owner: "u_1" } },
    });
    expect(counted).toEqual(["get_place"]);
  });

  it("lets the SDK refuse an argument the agent invented, naming it", async () => {
    const { app, counted } = harness();
    const answer = await callTool(app, { id: "p_1", bogus: 1 });
    expect(answer.isError).toBe(true);
    expect(answer.text).toMatch(/-32602.*bogus/s);
    expect(counted).toEqual([]);
  });

  it("answers a refusal with the REST envelope, and logs nothing for it", async () => {
    const { app, logs } = harness();
    expect(await callTool(app, { id: "missing" })).toMatchObject({
      isError: true,
      body: { error: { code: "NOT_FOUND", message: "Place not found" } },
    });
    expect(logs).toEqual([]);
  });

  it("logs a 5xx raised on purpose, and keeps its message", async () => {
    const { app, logs, unexpected } = harness();
    expect(await callTool(app, { id: "down" })).toMatchObject({
      isError: true,
      body: { error: { code: "SERVICE_UNAVAILABLE", message: "Maps is down, try in a minute" } },
    });
    expect(logs).toMatchObject([
      { message: "tool failed", meta: { requestId: "req_1", tool: "get_place", kind: "server" } },
    ]);
    expect(unexpected).toEqual([]);
  });

  it("masks a throw nobody raised on purpose, logs the raw error, and calls onUnexpected", async () => {
    const { app, logs, unexpected } = harness();
    const answer = await callTool(app, { id: "bug" });
    expect(answer).toMatchObject({
      isError: true,
      body: { error: { code: "INTERNAL_ERROR", message: "Something on our side failed" } },
    });
    expect(answer.text).not.toContain("ECONNREFUSED");
    expect(logs).toHaveLength(1);
    expect(logs[0]?.meta).toMatchObject({ kind: "unexpected", tool: "get_place" });
    expect(String(logs[0]?.meta?.error)).toContain("ECONNREFUSED");
    expect(unexpected).toEqual(["get_place"]);
  });

  it("does not throw when building the deps fails", async () => {
    const { app } = harness({ deps: () => Promise.reject(new Error("the pool is closed")) });
    const answer = await callTool(app, { id: "p_1" });
    expect(answer.isError).toBe(true);
    expect(answer.text).not.toContain("the pool is closed");
  });

  it("runs beforeCall once per call in a batch, and a refusal there answers that call only", async () => {
    let allowed = 2;
    const { app, counted } = harness({
      beforeCall: (tool) => {
        counted.push(tool);
        if (allowed-- <= 0)
          throw appError("RATE_LIMIT_EXCEEDED", "Too many calls", { retryAfterSecs: 30 });
      },
    });
    const { json } = await post(app, [
      call(1, { id: "a" }),
      call(2, { id: "b" }),
      call(3, { id: "c" }),
    ]);
    const answers = json as {
      id: number;
      result: { content: { text: string }[]; isError?: boolean };
    }[];
    expect(counted).toHaveLength(3);
    const byId = Object.fromEntries(answers.map((a) => [a.id, a.result]));
    expect(byId[1]?.isError).toBeUndefined();
    expect(byId[2]?.isError).toBeUndefined();
    expect(byId[3]?.isError).toBe(true);
    expect(JSON.parse(byId[3]!.content[0]!.text)).toMatchObject({
      error: { code: "RATE_LIMIT_EXCEEDED", details: { retryAfterSecs: 30 } },
    });
  });

  it("uses present for the success answer", async () => {
    const { app } = harness({
      present: (result) => ({
        content: [
          { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
          { type: "text", text: JSON.stringify({ data: result }) },
        ],
      }),
    });
    const { json } = await post(app, call(1, { id: "p_1" }));
    expect(json).toMatchObject({ result: { content: [{ type: "image" }, { type: "text" }] } });
  });

  it("hands present the call's own deps, and waits for it", async () => {
    let calls = 0;
    const { app } = harness({
      // A fresh object per call, as a per-call side channel (an image to show) would be.
      deps: () => ({ userId: `u_${++calls}` }),
      present: async (result, tool, deps) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          content: [{ type: "text", text: JSON.stringify({ tool, by: deps.userId, result }) }],
        };
      },
    });
    const { json } = await post(app, [call(1, { id: "a" }), call(2, { id: "b" })]);
    const texts = (json as { result: { content: { text: string }[] } }[]).map(
      (answer) => JSON.parse(answer.result.content[0]!.text) as unknown,
    );
    expect(texts).toEqual([
      { tool: "get_place", by: "u_1", result: { id: "a", owner: "u_1" } },
      { tool: "get_place", by: "u_2", result: { id: "b", owner: "u_2" } },
    ]);
  });

  it("answers a present that throws as a failed call, logged, and never throws itself", async () => {
    const { app, logs, unexpected } = harness({
      // Async on purpose: a rejection returned without `await` escapes the handler's `catch`.
      present: async () => {
        throw new Error("preview encoder crashed at /srv/app/preview.ts:12");
      },
    });
    const answer = await callTool(app, { id: "p_1" });
    expect(answer).toMatchObject({ isError: true, body: { error: { code: "INTERNAL_ERROR" } } });
    expect(answer.text).not.toContain("/srv/app");
    expect(logs).toHaveLength(1);
    expect(unexpected).toEqual(["get_place"]);
  });

  it("registers a mixed list typed by the app's own operation layer, in one loop", async () => {
    // The shape an app's `defineOperation` returns: `run` as a property, and the schema typed.
    interface AppOperation<I, O> {
      name: string;
      description: string;
      inputSchema: z.ZodType<I>;
      run: (deps: Deps, args: I) => Promise<O>;
    }
    const echo: AppOperation<{ text: string }, string> = {
      name: "echo",
      description: "Says it back.",
      inputSchema: z.object({ text: z.string() }).strict(),
      run: async (_deps, args) => args.text,
    };
    const count: AppOperation<{ n: number }, number> = {
      name: "count",
      description: "Adds one.",
      inputSchema: z.object({ n: z.number() }).strict(),
      run: async (_deps, args) => args.n + 1,
    };
    const { counted, built } = harness();
    const server = new McpServer({ name: "t", version: "0" });
    const door: ToolDoor<Deps> = {
      errorResponse,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      deps: () => ({ userId: "u" }),
      beforeCall: (tool) => void counted.push(tool),
    };
    for (const op of [echo, count]) registerOperation(server, op, door);
    const app = new Hono().route(
      "/",
      mcpRoutes("/mcp", () => server, { allowedOrigins: new Set() }),
    );
    const { json } = await post(app, [
      { ...call(1, {}), params: { name: "echo", arguments: { text: "hi" } } },
      { ...call(2, {}), params: { name: "count", arguments: { n: 1 } } },
    ]);
    expect(json).toMatchObject([
      { id: 1, result: { content: [{ text: '{"data":"hi"}' }] } },
      { id: 2, result: { content: [{ text: '{"data":2}' }] } },
    ]);
    expect(counted).toEqual(["echo", "count"]);
    expect(built).toEqual([]);
  });

  it("will not take a schema's .shape", () => {
    const shape = { id: z.string() };
    const op: ToolOperation<Deps, { id: string }, string> = {
      name: "x",
      description: "x",
      // @ts-expect-error a shape would be rebuilt as a loose object, dropping unknown keys
      inputSchema: shape,
      run: async () => "x",
    };
    expect(op.name).toBe("x");
  });
});

describe("toolError", () => {
  it("never rethrows, even for a value that is not an Error", () => {
    const logs: LogLine[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message: string, meta?: Record<string, unknown>) => void logs.push({ message, meta }),
    };
    const result = toolError({ weird: true }, "t", { errorResponse, logger });
    expect(result.isError).toBe(true);
    expect(logs).toHaveLength(1);
  });
});

describe("mcpRoutes", () => {
  it("serves the path with and without the slash", async () => {
    const { app } = harness();
    for (const path of ["/mcp", "/mcp/"])
      expect((await post(app, call(1, { id: "p" }), { path })).res.status).toBe(200);
  });

  it("refuses a GET at once, with Allow: POST, instead of holding an empty stream open", async () => {
    const { app, built } = harness();
    for (const method of ["GET", "DELETE"]) {
      const res = await app.request("/mcp", { method, headers: HEADERS });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(await res.json()).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32000 } });
    }
    expect(built).toEqual([]);
  });

  it("refuses a browser origin it does not know, and takes a known one or none", async () => {
    const { app } = harness();
    const evil = await post(app, call(1, { id: "p" }), {
      headers: { origin: "https://evil.test" },
    });
    expect(evil.res.status).toBe(403);
    expect(evil.json).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
    const known = await post(app, call(1, { id: "p" }), {
      headers: { origin: "https://app.acme.test" },
    });
    expect(known.res.status).toBe(200);
  });

  it("works after a middleware has read the body", async () => {
    const { app: door } = harness();
    const app = new Hono()
      .use("/mcp/*", async (c, next) => {
        await c.req.json();
        await next();
      })
      .route("/", door);
    expect((await post(app, call(1, { id: "p" }))).res.status).toBe(200);
  });

  it("answers a body that is not JSON with a JSON-RPC parse error", async () => {
    const { app } = harness();
    const { res, json } = await post(app, "{not json");
    expect(res.status).toBe(400);
    expect(json).toMatchObject({ error: { code: -32700 } });
  });

  it("closes the server once it has answered", async () => {
    const { app, built } = harness();
    await post(app, call(1, { id: "p" }));
    expect(built).toHaveLength(1);
    expect(built[0]?.isConnected()).toBe(false);
  });
});

describe("guarding the door", () => {
  it("covers both spellings from /mcp/*, and only one from /mcp", async () => {
    const statuses = async (guarded: string) => {
      const { app: door } = harness();
      const app = new Hono()
        .use(guarded, async (c, next) =>
          c.req.header("authorization") ? next() : c.json({ error: "no key" }, 401),
        )
        .route("/", door);
      return Promise.all(
        ["/mcp", "/mcp/"].map(
          async (path) => (await post(app, call(1, { id: "p" }), { path })).res.status,
        ),
      );
    };
    expect(await statuses("/mcp/*")).toEqual([401, 401]);
    expect(await statuses("/mcp")).toEqual([401, 200]);
  });
});
