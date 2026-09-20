import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { created, noContent, ok, paginated } from "./responses.ts";

/**
 * Every assertion here reads the BYTES off a real request, never the return value of a builder.
 * That is the point: the outage this file exists to prevent was invisible to any test that calls
 * the module, because the wrong value was still a perfectly good JSON value.
 */
const app = new Hono()
  .get("/ok", (c) => ok(c, { id: "a" }))
  .get("/accepted", (c) => ok(c, { id: "a" }, 202))
  .post("/created", (c) => created(c, { id: "a" }))
  .get("/page", (c) => paginated(c, [1, 2], { total: 9, limit: 2, offset: 0 }))
  .get("/last-page", (c) => paginated(c, [9], { total: 9, limit: 2, offset: 8 }))
  .delete("/gone", (c) => noContent(c));

describe("the Hono success adapters", () => {
  it("answers the envelope itself, never the { status, body } wrapper around it", async () => {
    const res = await app.request("/ok");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { id: "a" } });
  });

  it("keeps the status the route asked for", async () => {
    expect((await app.request("/accepted")).status).toBe(202);
    expect((await app.request("/created", { method: "POST" })).status).toBe(201);
    expect(await (await app.request("/created", { method: "POST" })).json()).toEqual({
      data: { id: "a" },
    });
  });

  it("computes hasMore from the rows returned, not from the limit", async () => {
    expect(await (await app.request("/page")).json()).toEqual({
      data: [1, 2],
      meta: { total: 9, limit: 2, offset: 0, hasMore: true },
    });
    expect(await (await app.request("/last-page")).json()).toEqual({
      data: [9],
      meta: { total: 9, limit: 2, offset: 8, hasMore: false },
    });
  });

  it("sends a 204 with no body and no content-type", async () => {
    const res = await app.request("/gone", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBeNull();
    expect(await res.text()).toBe("");
  });
});
