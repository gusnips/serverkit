/**
 * The transport, driven through a fake fetch. Each row of the retry matrix is a call the retry
 * rule answers differently for a read and a write, with and without a key: the rule itself is
 * tested in `@gusnips/http`, and what is tested here is that the transport asks it the right
 * question.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  failureOf,
  send,
  type Failure,
  type RequestOptions,
  type RequestSpec,
  type Transport,
} from "./transport.ts";

const BASE = "https://api.example.test/v1";

/** A failure turned into an error the way an SDK would, keeping the whole failure to assert on. */
class SdkError extends Error {
  constructor(readonly failure: Failure) {
    super(failure.error?.message ?? `${failure.method} ${failure.path} failed (${failure.status})`);
  }
}

type Reply = () => Response;

const ok =
  (data: unknown, meta?: unknown): Reply =>
  () =>
    Response.json(meta === undefined ? { data } : { data, meta });

/** A refusal in the envelope: `{ error: { code, message, details } }`. */
function refuse(
  status: number,
  {
    code = "REFUSED",
    details,
    headers,
  }: { code?: string; details?: unknown; headers?: Record<string, string> } = {},
): Reply {
  return () =>
    Response.json(
      {
        error: {
          code,
          message: `Refused with ${status}.`,
          ...(details !== undefined && { details }),
        },
      },
      { status, headers },
    );
}

/** No answer at all: what fetch does offline. */
const offline: Reply = () => {
  throw new TypeError("fetch failed");
};

interface Call {
  url: URL;
  method: string | undefined;
  headers: Headers;
  body: unknown;
  at: number;
}

/** A fetch that answers with `replies` in order, repeating the last one. */
function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    calls.push({
      url: new URL(String(input)),
      method: init.method,
      headers: new Headers(init.headers),
      body: init.body,
      at: Date.now(),
    });
    const reply = replies[Math.min(calls.length, replies.length) - 1];
    if (reply === undefined) throw new Error("fakeFetch needs at least one reply");
    return reply();
  };
  return { fetch, calls };
}

type Outcome = { ok: true; data: unknown; meta: unknown } | { ok: false; error: unknown };

/**
 * Sends one call and plays every timer it sets, so a retry's wait takes no real time while
 * `Date.now()` still moves by it.
 */
async function call(
  spec: RequestSpec,
  replies: Reply[],
  {
    params,
    opts,
    transport,
  }: { params?: object; opts?: RequestOptions; transport?: Partial<Transport> } = {},
) {
  const { fetch, calls } = fakeFetch(replies);
  let outcome: Outcome | undefined;
  send(
    { baseUrl: BASE, fetch, error: (failure) => new SdkError(failure), ...transport },
    spec,
    params,
    opts,
  ).then(
    ({ data, meta }) => {
      outcome = { ok: true, data, meta };
    },
    (error: unknown) => {
      outcome = { ok: false, error };
    },
  );
  while (outcome === undefined) {
    await new Promise((resolve) => setImmediate(resolve));
    vi.advanceTimersToNextTimer();
  }
  return { calls, outcome };
}

function thrownFailure(outcome: Outcome): Failure {
  if (outcome.ok || !(outcome.error instanceof SdkError)) {
    throw new Error(`expected an SdkError, got ${JSON.stringify(outcome)}`);
  }
  return outcome.error.failure;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  // Backoff lands on 1 s·2ⁿ exactly.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const GET: RequestSpec = { method: "GET", path: "/things" };
const WRITE: RequestSpec = { method: "POST", path: "/things" };
const KEYED: RequestSpec = { method: "POST", path: "/things", keyed: true };
const KEY = { idempotencyKey: "k-1" };

describe("send: which failures are tried again", () => {
  it.each<
    [
      string,
      RequestSpec,
      Reply[],
      number,
      { opts?: RequestOptions; transport?: Partial<Transport> }?,
    ]
  >([
    ["a read after a 503", GET, [refuse(503), ok(1)], 2],
    ["a write after a 503: never, it may have run", WRITE, [refuse(503), ok(1)], 1],
    [
      "a keyed write with the caller's key after a 503",
      KEYED,
      [refuse(503), ok(1)],
      2,
      { opts: KEY },
    ],
    ["a keyed write with no key, none minted", KEYED, [refuse(503), ok(1)], 1],
    [
      "a keyed write with a minted key",
      KEYED,
      [refuse(503), ok(1)],
      2,
      { transport: { mintKeys: true } },
    ],
    ["a write the API marks repeatable", { ...WRITE, repeatable: true }, [refuse(503), ok(1)], 2],
    ["a read marked not repeatable", { ...GET, repeatable: false }, [refuse(503), ok(1)], 1],
    ["a read with no answer", GET, [offline, ok(1)], 2],
    ["a write with no answer: never, it may have run", WRITE, [offline, ok(1)], 1],
    ["a write after a 408: nothing ran", WRITE, [refuse(408), ok(1)], 2],
    ["a write after a 425: nothing ran", WRITE, [refuse(425), ok(1)], 2],
    ["a write after a 429 with no wait: nothing ran", WRITE, [refuse(429), ok(1)], 2],
    [
      "a keyed write after a 409 that states a wait: its first run is still going",
      KEYED,
      [refuse(409, { headers: { "retry-after": "1" } }), ok(1)],
      2,
      { opts: KEY },
    ],
    [
      "a keyed write after a 409 with no wait: an answer",
      KEYED,
      [refuse(409), ok(1)],
      1,
      { opts: KEY },
    ],
    [
      "a write with no key after a 409 with a wait",
      WRITE,
      [refuse(409, { headers: { "retry-after": "1" } }), ok(1)],
      1,
    ],
    [
      "a read refused with a durable code",
      GET,
      [refuse(503, { code: "QUOTA_SPENT" }), ok(1)],
      1,
      { transport: { durableCodes: ["QUOTA_SPENT"] } },
    ],
    [
      "a read whose answer says waiting never helps",
      GET,
      [refuse(503, { details: { retryAfterSecs: null } }), ok(1)],
      1,
    ],
    [
      "a read whose stated wait is over the longest worth holding",
      GET,
      [refuse(429, { headers: { "retry-after": "11" } }), ok(1)],
      1,
    ],
    [
      "a read whose header says 2 s and body says 20 s: the header is read first",
      GET,
      [refuse(429, { headers: { "retry-after": "2" }, details: { retryAfterSecs: 20 } }), ok(1)],
      2,
    ],
    ["a read after a 400: an answer", GET, [refuse(400), ok(1)], 1],
    ["a read after 503s, until the retries run out", GET, [refuse(503)], 3],
    [
      "a read with retries turned off",
      GET,
      [refuse(503), ok(1)],
      1,
      { transport: { maxRetries: 0 } },
    ],
  ])("%s", async (_label, spec, replies, attempts, options) => {
    const { calls, outcome } = await call(spec, replies, options);
    expect(calls).toHaveLength(attempts);
    const worked = replies.length > 1 && attempts === replies.length;
    expect(outcome.ok).toBe(worked);
  });

  it("waits what the header says, in seconds or as a date, and backs off otherwise", async () => {
    const seconds = await call(GET, [refuse(429, { headers: { "retry-after": "3" } }), ok(1)]);
    expect(seconds.calls[1]!.at - seconds.calls[0]!.at).toBe(3000);

    const date = new Date(Date.now() + 3000).toUTCString();
    const dated = await call(GET, [refuse(503, { headers: { "retry-after": date } }), ok(1)]);
    expect(dated.calls[1]!.at - dated.calls[0]!.at).toBe(3000);

    const backoff = await call(GET, [refuse(503), refuse(503), ok(1)]);
    const [first, second, third] = backoff.calls.map((c) => c.at);
    expect([second! - first!, third! - second!]).toEqual([1000, 2000]);
  });
});

describe("send: the idempotency key", () => {
  it("mints one key per call and sends it on every attempt", async () => {
    const { calls, outcome } = await call(KEYED, [refuse(503), ok(1)], {
      transport: { mintKeys: true },
    });
    expect(outcome.ok).toBe(true);
    const keys = calls.map((c) => c.headers.get("idempotency-key"));
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("sends the caller's key, and hands it to the error so a later retry can reuse it", async () => {
    const { calls, outcome } = await call(KEYED, [refuse(400)], {
      opts: KEY,
      transport: { mintKeys: true },
    });
    expect(calls[0]!.headers.get("idempotency-key")).toBe("k-1");
    expect(thrownFailure(outcome).idempotencyKey).toBe("k-1");
  });

  it("sends no key on a call that takes none, even when minting", async () => {
    const { calls } = await call(WRITE, [ok(1)], { transport: { mintKeys: true } });
    expect(calls[0]!.headers.has("idempotency-key")).toBe(false);
  });

  it("refuses a key for a call that takes none, before sending anything", async () => {
    const { calls, outcome } = await call(WRITE, [ok(1)], { opts: KEY });
    expect(calls).toHaveLength(0);
    expect(outcome.ok ? undefined : outcome.error).toBeInstanceOf(TypeError);
  });
});

describe("send: the request", () => {
  it("fills the path, and puts the rest of a read in the query, a list as the name repeated", async () => {
    const { calls } = await call({ method: "GET", path: "/numbers/:numberId/messages" }, [ok([])], {
      params: {
        numberId: "n 1/a",
        status: ["sent", "read"],
        limit: 10,
        cursor: undefined,
        after: null,
      },
    });
    const { url, body, headers } = calls[0]!;
    expect(url.pathname).toBe("/v1/numbers/n%201%2Fa/messages");
    expect(url.search).toBe("?status=sent&status=read&limit=10");
    expect(body).toBeUndefined();
    expect(headers.has("content-type")).toBe(false);
  });

  it("puts a DELETE's params in the query and sends no body", async () => {
    const { calls } = await call({ method: "DELETE", path: "/numbers/:id" }, [ok(null)], {
      params: { id: "n1", force: true },
    });
    expect(calls[0]!.method).toBe("DELETE");
    expect(calls[0]!.url.search).toBe("?force=true");
    expect(calls[0]!.body).toBeUndefined();
  });

  it("sends a write's params as JSON, without the ones the path took, and `{}` when there are none", async () => {
    const { calls } = await call({ method: "PATCH", path: "/numbers/:id" }, [ok(1)], {
      params: { id: "n1", name: "Sales", tags: ["a"] },
    });
    expect(calls[0]!.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ name: "Sales", tags: ["a"] });

    const empty = await call(WRITE, [ok(1)]);
    expect(empty.calls[0]!.body).toBe("{}");
  });

  it("refuses a path value it does not have, rather than send an empty segment", async () => {
    const spec: RequestSpec = { method: "POST", path: "/numbers/:id/pair" };
    for (const params of [{}, { id: "" }, { id: null }, { id: { nested: true } }]) {
      const { calls, outcome } = await call(spec, [ok(1)], { params });
      expect(calls).toHaveLength(0);
      expect(outcome.ok ? undefined : outcome.error).toBeInstanceOf(TypeError);
    }
  });

  it("refuses an object in a query string, rather than send [object Object]", async () => {
    const { calls, outcome } = await call(GET, [ok(1)], { params: { filter: { a: 1 } } });
    expect(calls).toHaveLength(0);
    expect(outcome.ok ? undefined : outcome.error).toBeInstanceOf(TypeError);
  });

  it("sends the SDK's headers, asks for JSON, and joins a base URL with a trailing slash", async () => {
    const { calls } = await call(GET, [ok(1)], {
      transport: { baseUrl: `${BASE}/`, headers: { authorization: "Bearer k" } },
    });
    expect(calls[0]!.url.toString()).toBe(`${BASE}/things`);
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer k");
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
  });

  it("gives the timeout hook the spec and params, and lets a call override it", async () => {
    const timeoutMs = vi.fn(() => 5000);
    const hooked = await call(WRITE, [offline], { params: { a: 1 }, transport: { timeoutMs } });
    expect(timeoutMs).toHaveBeenCalledWith(WRITE, { a: 1 });
    expect(thrownFailure(hooked.outcome).timeoutMs).toBe(5000);

    const own = await call(WRITE, [offline], {
      opts: { timeoutMs: 700 },
      transport: { timeoutMs },
    });
    expect(thrownFailure(own.outcome).timeoutMs).toBe(700);

    const fallback = await call(WRITE, [offline]);
    expect(thrownFailure(fallback.outcome).timeoutMs).toBe(30_000);
  });

  it.each([-1, 0, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "refuses a timeout of %s, from the call or the SDK, before sending anything",
    async (timeoutMs) => {
      for (const where of [
        { opts: { timeoutMs } },
        { transport: { timeoutMs: () => timeoutMs } },
      ]) {
        const { calls, outcome } = await call(GET, [ok(1)], where);
        expect(outcome.ok ? undefined : outcome.error).toEqual(
          new RangeError(
            `GET /things: timeoutMs must be a whole number of milliseconds from 1 to 2147483647, not ${timeoutMs}.`,
          ),
        );
        expect(calls).toHaveLength(0);
      }
    },
  );

  it("takes a timeout from 1 ms to the longest a timer holds", async () => {
    for (const timeoutMs of [1, 2_147_483_647]) {
      const { outcome } = await call(GET, [ok(1)], { opts: { timeoutMs } });
      expect(outcome).toEqual({ ok: true, data: 1, meta: undefined });
    }
  });
});

describe("send: the answer", () => {
  it("returns data and meta", async () => {
    const { outcome } = await call(GET, [ok({ id: "a" }, { total: 1 })]);
    expect(outcome).toEqual({ ok: true, data: { id: "a" }, meta: { total: 1 } });
  });

  it("gives undefined data for a 204 or a 205, the statuses with no body", async () => {
    for (const status of [204, 205]) {
      const { outcome } = await call(WRITE, [() => new Response(null, { status })]);
      expect(outcome).toEqual({ ok: true, data: undefined, meta: undefined });
    }
  });

  it("takes `data: null` as an answer, so a read of something unset still works", async () => {
    const { outcome } = await call(GET, [ok(null)]);
    expect(outcome).toEqual({ ok: true, data: null, meta: undefined });
  });

  // Seven 200s the SDK one adopter replaced refused as an invalid answer. Before, the last four
  // came out as a success with `data` undefined, typed as the DTO the caller asked for.
  it.each([
    ["not json", "not json"],
    ["null", "null"],
    ["[]", "[]"],
    ["", undefined],
    ["{}", "{}"],
    ['{"error":{"message":"bad"}}', '{"error":{"message":"bad"}}'],
    ['{"data":[],"error":{}}', '{"data":[],"error":{}}'],
  ])(
    "refuses a 200 of %j, which is not the envelope, and does not send it again",
    async (body, text) => {
      const { calls, outcome } = await call(GET, [() => new Response(body, { status: 200 })]);
      expect(thrownFailure(outcome)).toMatchObject({ status: 200, error: undefined, text });
      expect(calls).toHaveLength(1);
    },
  );

  // A 2xx is never the API refusing, so a code in its body is not handed on as one. Passed on,
  // every SDK's error builder would throw NOT_FOUND with a 200 unless it guarded it itself.
  it.each([
    { error: { code: "NOT_FOUND", message: "No such place" } },
    { data: [], error: { code: "PARTIAL" } },
  ])("hands over no error code from a 2xx body such as %j, only its text", async (body) => {
    const failure = thrownFailure((await call(GET, [() => Response.json(body)])).outcome);
    expect(failure).toMatchObject({ status: 200, error: undefined, text: JSON.stringify(body) });
  });

  it("hands the error builder the envelope, the wait and the request id", async () => {
    const reply = refuse(429, {
      code: "RATE_LIMITED",
      details: { limit: 5 },
      headers: { "retry-after": "60", "x-request-id": "req_1" },
    });
    const failure = thrownFailure((await call(WRITE, [reply])).outcome);
    expect(failure).toMatchObject({
      method: "POST",
      path: "/things",
      status: 429,
      timedOut: false,
      error: { code: "RATE_LIMITED", message: "Refused with 429.", details: { limit: 5 } },
      text: undefined,
      retryAfterSecs: 60,
      requestId: "req_1",
    });
  });

  it("keeps the text of an answer that is not the envelope, a 2xx included", async () => {
    const html = () => new Response("<html>Bad gateway</html>", { status: 502 });
    const gateway = thrownFailure((await call(WRITE, [html])).outcome);
    expect(gateway).toMatchObject({
      status: 502,
      error: undefined,
      text: "<html>Bad gateway</html>",
    });

    const notJson = () => new Response("<html>Welcome</html>", { status: 200 });
    const portal = thrownFailure((await call(GET, [notJson])).outcome);
    expect(portal).toMatchObject({ status: 200, text: "<html>Welcome</html>" });
  });

  it("hands over the answer's headers, and none when no answer came back", async () => {
    const reply = refuse(422, {
      code: "BLOCKED",
      headers: { "x-request-cost": "0", "x-credits-remaining": "988" },
    });
    const failure = thrownFailure((await call(WRITE, [reply])).outcome);
    expect(failure.headers?.get("x-request-cost")).toBe("0");
    expect(failure.headers?.get("x-credits-remaining")).toBe("988");
    expect(thrownFailure((await call(WRITE, [offline])).outcome).headers).toBeUndefined();
  });

  it("reads a refusal the SDK fetched itself the way it reads its own", async () => {
    const reply = refuse(429, {
      code: "RATE_LIMITED",
      details: { retryAfterSecs: null },
      headers: { "retry-after": "60", "x-request-id": "req_1" },
    });
    const sent = thrownFailure((await call(GET, [reply])).outcome);
    const response = reply();
    const read = failureOf(
      { method: "GET", path: "/things", timeoutMs: 30_000 },
      response,
      await response.text(),
    );
    expect(read).toEqual({ ...sent, headers: expect.any(Headers) });
    expect(read.headers?.get("x-request-id")).toBe("req_1");
  });

  it("reads a refusal to a request that had no deadline, such as a stream", async () => {
    const response = refuse(403, { code: "FORBIDDEN" })();
    const read = failureOf(
      { method: "GET", path: "/jobs/j_1/stream" },
      response,
      await response.text(),
    );
    expect(read).toMatchObject({ status: 403, timedOut: false, error: { code: "FORBIDDEN" } });
    expect(read.timeoutMs).toBeUndefined();
  });

  it("reports no answer as status 0, and says when it was the timeout", async () => {
    const timeout: Reply = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const failure = thrownFailure((await call(WRITE, [timeout])).outcome);
    expect(failure).toMatchObject({ status: 0, timedOut: true });
    expect(thrownFailure((await call(WRITE, [offline])).outcome)).toMatchObject({
      status: 0,
      timedOut: false,
    });
  });
});

describe("send: the caller's signal", () => {
  const reason = new Error("The reader closed the page.");

  it("sends nothing when the signal has already aborted, and throws its reason", async () => {
    const controller = new AbortController();
    controller.abort(reason);
    const { calls, outcome } = await call(GET, [ok({})], { opts: { signal: controller.signal } });
    expect(calls).toHaveLength(0);
    expect(outcome).toEqual({ ok: false, error: reason });
  });

  it("stops a call that is out, throws the reason rather than the SDK's error, and never retries", async () => {
    const controller = new AbortController();
    let sent = 0;
    // A fetch as the transport calls it: two arguments, no cast.
    const fetch = (_url: string, init: RequestInit) => {
      sent++;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        controller.abort(reason);
      });
    };
    const { outcome } = await call(GET, [ok({})], {
      opts: { signal: controller.signal },
      transport: { fetch },
    });
    expect(outcome).toEqual({ ok: false, error: reason });
    expect(sent).toBe(1);
  });

  it("stops during the wait before a retry, without waiting it out", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const unavailable: Reply = () => {
      setTimeout(() => controller.abort(reason), 100);
      return refuse(503)();
    };
    const { calls, outcome } = await call(GET, [unavailable, ok({})], {
      opts: { signal: controller.signal },
    });
    expect(outcome).toEqual({ ok: false, error: reason });
    expect(calls).toHaveLength(1);
    expect(Date.now() - start).toBe(100);
  });

  it("still times an attempt out, and reports it as the SDK's error", async () => {
    const controller = new AbortController();
    const timeout: Reply = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const { outcome } = await call(WRITE, [timeout], { opts: { signal: controller.signal } });
    expect(thrownFailure(outcome)).toMatchObject({ status: 0, timedOut: true });
  });
});
