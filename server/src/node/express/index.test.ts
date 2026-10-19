import type { AddressInfo } from "node:net";
import express, { type ErrorRequestHandler } from "express";
import type { HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createAppError, createErrorResponse, createLogger } from "../../index.ts";
import {
  errorHandler,
  restRoutes,
  type RequestVariables,
  type RestRequest,
} from "../../hono/index.ts";
import { fromHono } from "./index.ts";

const appError = createAppError({ VALIDATION_ERROR: 400, TOO_LARGE: 413 } as const);
const errorResponse = createErrorResponse({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
});

/** A Hono API under /v1, built the way an Express backend would, that remembers what it ran. */
function api() {
  const ran: RestRequest[] = [];
  const app = new Hono<{ Bindings: HttpBindings; Variables: RequestVariables }>();
  app.onError(errorHandler({ errorResponse, logger: createLogger({ write: () => {} }) }));
  const run = async (_c: unknown, request: RestRequest) => {
    ran.push(request);
    return { data: request };
  };
  // What a route reads the caller's address from, behind the bridge as on a plain Node server.
  app.get("/v1/peer", (c) => c.text(c.env.incoming.socket.remoteAddress ?? "none"));
  app.route(
    "/v1",
    restRoutes(
      [
        { method: "get", path: "/things/:id", run },
        { method: "post", path: "/things/:id", run },
      ],
      {
        bodyLimit: 1024,
        tooLarge: (maxBytes) => appError("TOO_LARGE", `over ${maxBytes}`),
        invalidBody: (reason) => appError("VALIDATION_ERROR", reason),
      },
    ),
  );
  return { app, ran };
}

const servers: Array<{ close: () => void }> = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

async function serve(app: express.Express): Promise<string> {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await new Promise((resolve) => server.once("listening", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const reportError: ErrorRequestHandler = (err: Error, _req, res, _next) => {
  res.status(500).json({ message: err.message });
};

const json = { "content-type": "application/json" };

describe("fromHono", () => {
  it("hands Hono the full path, the query and the body, and leaves Express's other routes alone", async () => {
    const { app: hono } = api();
    const app = express();
    app.use("/v1", fromHono(hono));
    app.use(express.json());
    app.post("/legacy", (req, res) => {
      res.json({ body: req.body });
    });
    const base = await serve(app);

    const read = await fetch(`${base}/v1/things/7?tag=a&tag=b`);
    expect(await read.json()).toEqual({
      data: { params: { id: "7" }, input: { tag: ["a", "b"] } },
    });
    const write = await fetch(`${base}/v1/things/7`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ n: 1 }),
    });
    expect(await write.json()).toEqual({ data: { params: { id: "7" }, input: { n: 1 } } });
    const malformed = await fetch(`${base}/v1/things/7`, {
      method: "POST",
      headers: json,
      body: "{ nope",
    });
    expect(malformed.status).toBe(400);
    expect(await (await fetch(`${base}/v1/peer`)).text()).toMatch(/127\.0\.0\.1/);
    const legacy = await fetch(`${base}/legacy`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ a: 1 }),
    });
    expect(await legacy.json()).toEqual({ body: { a: 1 } });
  });

  it("refuses a request a body parser already read, instead of running it on an empty body", async () => {
    // Without the refusal, this POST reached the API as `{}` (measured).
    const { app: hono, ran } = api();
    const app = express();
    app.use(express.json());
    app.use("/v1", fromHono(hono));
    app.use(reportError);
    const base = await serve(app);

    const res = await fetch(`${base}/v1/things/7`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ n: 1 }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      message: expect.stringContaining("Mount fromHono before express.json()"),
    });
    expect(ran).toHaveLength(0);
  });
});
