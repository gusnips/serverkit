/**
 * The success half of the Hono edge: four adapters that put the envelope on the wire.
 *
 * They exist because the builders in `../responses.ts` return an ANSWER — `{ status, body }` —
 * and every Hono adopter therefore has to unwrap one before `c.json` sees it. Three of three
 * wrote these same four functions by hand, and one of the three wrote `c.json(ok(data))` instead
 * of `c.json(ok(data).body)`: every 200 from a live API answered
 * `{"status":200,"body":{"data":…}}` for fifty minutes. Nothing caught it. `c.json` takes any
 * JSON value, so the types were satisfied; the status was still 200, so every probe and every
 * deploy gate was satisfied; and a test that calls the module never sees the body its caller
 * sends. A client found it, because a client is the only reader that parses the envelope.
 *
 * A doc comment would have been read by whoever was already careful. These make the wrong line
 * unreachable, which is the only fix available to a package that owns both sides of the seam.
 */
import type { PaginationMeta } from "@gusnips/http";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ok as okBody, paginated as paginatedBody } from "../responses.ts";

/** `return ok(c, user)` — or `ok(c, job, 202)` where the route accepted rather than answered. */
export function ok<T>(c: Context, data: T, status: ContentfulStatusCode = 200) {
  return c.json(okBody(data).body, status);
}

export function created<T>(c: Context, data: T) {
  return ok(c, data, 201);
}

/** `hasMore` is computed from the rows actually returned — see `paginated` in `../responses.ts`. */
export function paginated<T>(c: Context, rows: T[], meta: Omit<PaginationMeta, "hasMore">) {
  return c.json(paginatedBody(rows, meta).body, 200);
}

/**
 * `c.body(null, 204)`, not `c.json`: a 204 carries no body, and `c.json(null, 204)` writes the
 * four bytes `null` and a `content-type` header under a status that promises neither.
 */
export function noContent(c: Context) {
  return c.body(null, 204);
}
