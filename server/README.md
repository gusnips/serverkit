# @gusnips/server

One error shape, one response envelope, and one function that turns a thrown thing into an HTTP
answer. No framework at the root: it runs in a Cloudflare Worker, in a Bun or Node server, in a
queue consumer, and in an MCP tool handler.

```bash
bun add @gusnips/server @gusnips/http
```

`@gusnips/http` declares the envelope, and your API and your browser client both import it, so
there is one declaration of the wire contract and not two. Install it whenever you answer a
request. It is an optional peer rather than a required one because this package uses it for its
types only, so its code never runs here — which means a server reaching only for a subpath like
`@gusnips/server/pg` installs the one package it actually loads:

```bash
bun add @gusnips/server pg
```

```ts
import { ok } from "@gusnips/server";

ok({ id: 1 });
// → { status: 200, body: { data: { id: 1 } } }
```

Every 2xx body is `{ data }`. Every refusal is `{ error: { code, message, messageKey?, params?,
details? } }`. That is the envelope `@gusnips/http` declares and a browser client parses, so the
two ends of one request never disagree about the shape.

**Import `ApiError`, `ApiSuccess` and `PaginationMeta` from `@gusnips/http`, not from here.**
This package does not re-export them, on purpose: two names for one type is how a version skew
becomes invisible. You already have the import — the contract is the package your client reads
it from too.

## Answering a request

`ok`, `created`, `paginated` and `noContent` return a plain `{ status, body }`. Hand it to
whatever is holding the connection.

```ts
import { paginated } from "@gusnips/server";

paginated(rows, { total: 128, limit: 20, offset: 100 });
// → { status: 200, body: { data: rows, meta: { total: 128, limit: 20, offset: 100, hasMore: true } } }
```

`hasMore` is computed from the rows you actually returned, not from `limit`, so a page cut short
by a filter still answers honestly.

**What comes back is an answer, not a body.** A framework wants the `body`:

```ts
return c.json(ok(data), 200); // WRONG: {"status":200,"body":{"data":…}}
return c.json(ok(data).body, 200); // the envelope
```

Nothing catches the first line. `c.json` takes any JSON value, so the types hold; the status is
still 200, so a health probe and a deploy gate both pass; and a test that calls `ok` never sees
the body its caller sends. That shipped, and a client found it fifty minutes later. On Hono,
import the four adapters from `@gusnips/server/hono` and the question does not arise.

## Refusing a request

Declare your own codes and what status each one answers with. The `satisfies` is the line that
matters: adding a code without a status becomes a build error instead of a route answering 500
for a refusal it knew how to explain.

```ts
import { createAppError } from "@gusnips/server";

export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMIT_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
} as const satisfies Record<ErrorCode, number>;

const appError = createAppError<typeof ERROR_STATUS, MessageKey>(ERROR_STATUS);

export const errors = {
  notFound: (what = "Resource") => appError("NOT_FOUND", `${what} not found`),
  rateLimit: (retryAfterSecs: number) =>
    appError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfterSecs }),
};
```

Then throw one, anywhere:

```ts
throw errors.notFound("Workspace");
```

`AppError` has no `toJSON()`. `JSON.stringify` calls a value's own `toJSON()` **before** it calls
the replacer, so a class that defines one hands a logger whatever that method returns instead of
the error: `logger.error("failed", { error: err })` writes `{"error":{"error":{code,message}}}`
with no stack and no cause. Seven backends on this stack define one and all seven log exactly
that.

`createLogger` recovers the error anyway — the replacer reads it back off the holder — so your
own classes are safe either way. `AppError` still does not define one, because the wire body
belongs to `errorResponse`, where the mask lives: one function owns the shape a client sees, and
the error stays an error.

The map has to be `as const`, or every value reads as `number` and the rule below cannot see a 429. A map without it is refused, with the instruction in the compiler's message.

### A 429 says how it clears

`RATE_LIMIT_EXCEEDED` maps to 429, so `retryAfterSecs` is a **required argument**: the seconds
until the caller may retry, or `null` for a refusal that waiting cannot fix. Leave it out and
the code does not compile.

```ts
rateLimit: (retryAfterSecs: number) =>
  appError("RATE_LIMIT_EXCEEDED", "Too many requests", { retryAfterSecs }),

concurrency: (limit: number) =>
  // A slot frees when somebody else's job finishes. There is no wait to state.
  appError("QUOTA_EXCEEDED", `${limit} jobs already running`, { retryAfterSecs: null }),
```

This is the rule with the best bug-per-line ratio in the whole extraction. One backend writes a
`resetAt` ISO date that no HTTP client parses, and then keeps a hand-written list of "codes that
do not clear by waiting" in its browser app to compensate — its own comment says that is why the
list exists. Another backend needs no list, because every 429 it sends states its wait. A third
raises a spent daily cap with no wait at all, on a code its client reads as transient, so the
browser retries a limit that clears at midnight — twice, immediately, and says the same thing
three times to a limiter that is already counting.

Asking each refusal how it clears answers the question those lists were guessing at, and it
answers it in the one place that knows: where the refusal is raised. A code cannot know — the
same `QUOTA_EXCEEDED` can be a month that clears in days or a slot that clears in two seconds.

Of 40 places that raise a 429 in the fleet this came from, 34 already state a wait. Of the six
left, two genuinely cannot: a concurrency slot frees when another job finishes, and a cap on
live objects clears by archiving one, never by waiting. `null` is for those. An omission is
invisible in a diff; a `null` is a claim somebody has to read.

`errorResponse` renders a number as the standard `Retry-After` header **and** folds it into
`details`, so an HTTP client, a proxy and your own SDK all learn the same wait from one value. A
`null` is folded in without a header, because a `Retry-After` that names no time is worse than
none.

Two edges worth knowing:

- The obligation follows the code's whole status set. A code narrowed to a union that _could_ be
  the 429 owes the wait too — `appError(code, msg)` where `code` is
  `"NOT_FOUND" | "RATE_LIMIT_EXCEEDED"` does not compile without one.
- **Only the obligation is 429-only.** Any code may state a wait, and a number renders
  `Retry-After` at any status. Reach for it when ONE of your codes is raised in two senses —
  one that clears on its own and one that does not. A `SERVICE_UNAVAILABLE` meaning "not
  configured on this deployment" and one meaning "did not answer just now" are the same code and
  the same status, so a client cannot separate them; the raiser can, with a number or an
  explicit `null`.

`new AppError(429, …)` skips the rule, because the rule lives on the factory: only the factory
knows your map. That is the reason to prefer `createAppError`.

## Turning a throw into an answer

```ts
import { createErrorResponse } from "@gusnips/server";

export const errorResponse = createErrorResponse<ErrorCode, MessageKey>({
  internal: { code: "INTERNAL_ERROR", message: "Something on our side failed" },
  validation: { code: "VALIDATION_ERROR", message: "The request could not be read" },
});

errorResponse(err);
// → { status, body, headers, kind }
```

Every throw lands in one of four arms:

| What was thrown              | Answer                                       | `kind`       |
| ---------------------------- | -------------------------------------------- | ------------ |
| a validation failure         | 400, with the field path and the failed rule | `client`     |
| an `AppError` under 500      | itself                                       | `client`     |
| an `AppError` of 500 or more | itself, or the masked body                   | `server`     |
| anything else                | a generic 500                                | `unexpected` |

`kind` is the one thing you cannot read off the status. A 500 you raised and a `TypeError` that
escaped are both 500s, and only the second one means nobody is watching a log for it — which is
the branch where an alert belongs.

Bind it once, at the edge of your app, and import that one function everywhere else. A tool
handler and a worker's health port then cannot disagree with the API about what a refusal looks
like. They did, in the fleet this came from: a worker's health route answered a caught Redis
message on a 503 while the API next door masked exactly that.

### What reaches the client, and what does not

**A validation failure ships the field path, the failed rule, and — for a range — the bound it
failed against. Nothing else.** Handing your validator's issues straight through ships back the
caller's own key names, the enum's allowed values, the validator's English sentence and the
expected type. The bound is the exception and it belongs to the caller: it is your published
contract, and a "too big" without it costs somebody a bisect to rediscover a number your docs
already state.

Validation is recognized by shape, not by an import, so your validator does not become this
package's dependency. Measured against zod 3.25, 4.4 and 4.5. A tool or queue consumer can use
`validationIssues(error)` from the root package to apply the same allow-list without building an
HTTP answer.

**A 5xx keeps its message unless its code is masked.** By default only `INTERNAL_ERROR` is,
because that is the code you raise when something unexpected broke, so its message may carry
internals. The others were written for the client, and flattening a `GATEWAY_ERROR` into a
generic 500 takes away the one thing that tells a developer whether to retry.

> That default is safe because of your call sites, not because of this code. It holds only while
> every unmasked 5xx is handed a message somebody wrote for a reader. If your data layer
> interpolates the driver's error into what it raises, use `maskAll` and let `expose` opt the
> authored sentences back in.

`maskDetails` is a separate knob, because it is a separate decision. Some backends put a
readiness report in a 503's `details` — which dependency is down, for the deploy gate and for a
human at 3am — and need it on the wire. Others record caught error text there, and must never
send it. Both are right about their own repo.

**When a message is masked, the status is not.** A status comes from your own map and discloses
nothing, and it is the last thing telling a client whether waiting can help.

**An unexpected throw never reaches the client.** Log it with its `cause` and its stack; answer
the generic 500.

## Logging a failure

`createLogger` writes one JSON line per event to stdout, and nothing else. Twelve backends were
read for this and not one installs a logging library, so this ships no transports, no file
rotation and no extra levels — every one of them runs under something that already owns stdout.

```ts
import { createLogger } from "@gusnips/server";

const logger = createLogger({ level: process.env.LOG_LEVEL });

logger.error("charge failed", { orderId, error: err }); // the RAW error, never String(err)
```

**Pass the error itself.** `message` and `stack` are non-enumerable, so a plain
`JSON.stringify(err)` is `{}` — which is how a logger ends up printing nothing about the failure
it was called to report. The serializer adds them, follows the `cause` chain and an
`AggregateError`'s `errors`, and collapses a circular reference instead of crashing the log call.

**What it keeps off an error is an allow-list**, and that is the one thing here that exists
because of an incident rather than because of duplication. An SDK hangs its own INPUTS off the
error it throws: a payment vendor's signature-verification error carries the unparsed webhook
body and the signature, a Redis client puts the AUTH password in `command.args`, and a Postgres
`DatabaseError` carries statement text with its literals in it. A loop over own properties copies
all of that, and a webhook route is unauthenticated by definition — so anyone on the internet
could choose what went into the log. The list admits 4 of that payment error's 25 properties, and
it covers the `cause` chain, including a link that is not an `Error`.

`level` is an argument rather than a `process.env` read, and that is the boundary the package is
built on: a Cloudflare Worker has no `process` at all, so a module-scope read makes a package
Node-only by accident. A Worker passes `env.LOG_LEVEL` from its handler argument. An unrecognized
level throws at construction, because a box running at the wrong level is discovered during the
incident it was meant to explain.

## Hono

`@gusnips/server/hono` is the only part that knows a framework, which is why it is a subpath:
`hono` is an optional peer and nothing in the root entry imports it. Needs `hono >= 4.9.9` —
before that, `routePath(c, -1)` silently ignores the `-1` and the request line names the wrong
route.

```ts
import { errorBoundary, errorHandler, notFoundHandler, requestLogger } from "@gusnips/server/hono";

app.use(requestLogger({ logger })); // first, so it times and sees everything under it
app.use(errorBoundary); // right after
app.onError(errorHandler({ errorResponse, logger }));
app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))));
```

```ts
import { created, noContent, ok, paginated } from "@gusnips/server/hono";

app.get("/users/:id", (c) => ok(c, user)); // { data: user }, 200
app.post("/users", (c) => created(c, user)); // 201
app.get("/users", (c) => paginated(c, rows, { total, limit, offset }));
app.delete("/users/:id", (c) => noContent(c)); // 204, no body, no content-type
```

Three adopters wrote those four functions by hand before they were here, and one of the three
got the unwrap wrong in production. `ok` takes an explicit status for the cases that are not
200 — `ok(c, job, 202)` where the route accepted rather than answered — and a fourth argument for
a product's own meta, so a metered read answers `{ data, meta }` without leaving the adapter:

```ts
app.get("/lookup", (c) => ok(c, profile, 200, { creditsCharged: 1, cache: "hit" }));
```

**`errorBoundary` is not optional.** Hono hands `onError` only what is `instanceof Error`.
Anything else is rethrown past every layer and escapes as an unhandled rejection: no answer, a
dropped connection, and a browser that reports it as a CORS failure — which sends whoever reads
it to the wrong layer entirely. A PostgREST client rejects with plain objects, so this is not
hypothetical. The boundary wraps one in an `Error` and keeps the original as `cause`.

**The request line names the route TEMPLATE, never the path.** A path is what puts a customer's
document number in a log and in whatever reads that log afterwards. `/health` is skipped with
everything under it, because every deploy polls it in a loop; a throw is logged anyway.

Add safe product metadata with `requestLogger<AppEnv>({ logger, fields: (c) => ({ … }) })`.
`fields` runs after the response exists, so it can read values a handler set and `c.res`; return only
bounded, sanitized values, never a raw path, query, header set, body or authentication object. Your
fields are written first, so they cannot replace the canonical request id, method, route, status,
duration or error code. A hook that throws is caught: the line is written with
`requestFieldsFailed: true` instead of your fields. A value whose own `toJSON` throws is not — that
one loses the whole line, request id included — so return plain data, not live objects.

The request id goes back on `X-Request-ID`, on every answer including `onError`'s and
`notFound`'s. A caller's own id is echoed only if it is 64 characters of `A-Z a-z 0-9 . _ -`,
so the id in a line is always either the caller's or ours. Cross-origin, list that header in your
CORS `exposeHeaders` or the browser hides it from the page.

### The guard check

```ts
import { assertEveryRouteGuarded, guard, underAny } from "@gusnips/server/hono";

export const requireUser = guard(async (c, next) => { … });   // mark it where it is defined

// in a test
assertEveryRouteGuarded(buildApp(), { isPublic: underAny(PUBLIC_PREFIXES) });
```

It walks every registered route through Hono's **own matcher** and fails naming each endpoint no
guard runs in front of. The matcher is the point: a `use` registered AFTER its `route` never runs
— the handler answers and the guard silently does not fire. A route whose guard did not fire is
indistinguishable from one with no guard, and comparing pattern lists cannot tell you which you
have.

Pass the app's own public rule, never a second list kept for the test — an exemption list nothing
else reads is the next thing to drift. It also fails a guard that runs in front of nothing, and
an app with no endpoints, so the check cannot pass by asking nothing.

## Supabase Auth

If your API verifies a Supabase token, it makes one decision every client depends on: did auth
say **no**, or did auth **not answer**?

```bash
bun add @supabase/supabase-js
```

```ts
import { isAuthOutage } from "@gusnips/server/supabase";

isAuthOutage(error);
// → true when auth failed to answer, false when it looked at the token and refused it
```

At the door:

```ts
const { data, error } = await supabase.auth.getUser(token);
if (isAuthOutage(error)) throw errors.serviceUnavailable("Authentication service unreachable");
if (error || !data.user) throw errors.invalidToken();
```

Only a refusal ends a session. Browser clients read a 401 as "your session is over" and sign the
person out, so answering an outage with a 401 signs out everyone who made a request during it —
while the refresh they are all waiting on is still in flight. A 503 is retried instead.

It tests two things and both are needed. The SDK's own `isAuthRetryableFetchError` catches a
fetch that never landed, plus the statuses on its `NETWORK_ERROR_CODES` list. That list is a
list and not a range, so it has holes at every version ever shipped: nothing for 505 through
519, nothing from 531 up. A 507 out of a proxy in front of GoTrue is auth failing to answer, and
the SDK's predicate says false for it. The status check covers the holes.

It takes `unknown`, so you can also ask it about whatever a `catch` around your own user lookup
caught. A driver's `TypeError` is not an auth outage and answers false.

`@supabase/supabase-js` is an optional peer, behind the `/supabase` subpath, so importing
`@gusnips/server` never installs it.

## Postgres

If your API talks to Postgres through `pg`, two lines in the pool decide whether a bad minute
shows up as an error or as silence.

```bash
bun add pg
```

```ts
import { createPgPool } from "@gusnips/server/pg";

const pool = createPgPool({
  connectionString: env.DATABASE_URL,
  onIdleError: (error) => logger.error("[pg] idle client error — client discarded", { error }),
});
```

**It bounds the wait for a free connection.** Without `connectionTimeoutMillis`, node-postgres
puts a caller that finds the pool full on a queue with no timer, and it waits forever. `max`
defaults to 10, so ten slow queries at once are enough: every request after them — auth,
billing, the workers, `/health` — hangs with no error, no log and no metric. That is not a 500,
it is silence, which is why it survives in a codebase. Eleven backends were measured for this
and one had it bounded. The default here is 10 seconds; pass
`connectionTimeoutMillis: 0` to wait forever on purpose, which a batch job may want.

**It makes the idle-error handler impossible to forget.** A `Pool` emits `error` when the server
closes an idle client — a restart, a failover, a dropped tunnel. With no listener, Node turns
that into an uncaught exception and a crash handler exits the process, so a connection nobody
was using takes the API down. `onIdleError` is a required field, not an option.

Readiness gets its own call, and it has a deadline:

```ts
const ok = await pingPool(pool, {
  timeoutMs: 2_000,
  onError: (e) => logger.warn("[pg] down", { e }),
});
```

A raw `SELECT 1` hangs when the database hangs, which is the one thing a health check must not
do: an orchestrator reads a timeout as "unknown" where it would read `false` as "replace this
container". `connectionTimeoutMillis` does not cover it — that bounds getting a connection, not
the query once you hold one.

Two things stay yours. The pool **singleton** — a package that holds it decides when your process
can exit. And the **`ssl` option**: `@gusnips/migrate` exports `pgSsl`, which infers it from the
connection URL, so spread it in beside `connectionString`.

`pg` is an optional peer, behind the `/pg` subpath, so importing `@gusnips/server` never
installs it.

## Redis

If your API uses Redis — for BullMQ, for rate-limit windows, for a cache — the connection and
the probe that reads it are one decision, because the first makes the second necessary.

```bash
bun add ioredis
```

```ts
import { createRedis, pingRedis } from "@gusnips/server/redis";

const redis = createRedis({
  url: env.REDIS_URL,
  onError: (error) => logger.error("[redis] connection error", { error }),
});
```

**It makes the error handler impossible to forget.** ioredis emits `error` on every failed
connect, and an EventEmitter with no `error` listener throws. Through the `uncaughtException`
handler most backends install for crash visibility, that is a process exit over a Redis blip the
client would have reconnected from by itself. `onError` is a required field, not an option. Four
backends were measured for this: all four wrote the listener, all four wrote a comment saying it
is not optional, and the function around it was byte-identical in every one.

**It defaults `maxRetriesPerRequest` to `null`, and that is the opposite kind of default from
`createPgPool`'s.** There the default makes an unbounded wait bounded; here it makes commands
wait forever — because BullMQ requires it, since its blocking reads must never be cut short by a
retry limit. So the default is right and it has a consequence worth saying once:

**every read on this connection needs its own bound.** A `ping`, a cache lookup, a limiter
check, a `queue.add()` — with Redis down, each waits rather than failing. Pass
`maxRetriesPerRequest: 3` for a connection that serves ordinary commands instead of BullMQ's.

Readiness is the worked example, and it has a deadline:

```ts
const ok = await pingRedis(redis, {
  timeoutMs: 2_000,
  onError: (e) => logger.warn("[redis] down", { e }),
});
```

Four hand-written copies of that bound exist in this fleet and all four leak their timer — a
pending 2-second timer per health check, in a process something probes every few seconds. This
one clears it.

A worker gets a boot gate, because a process whose queues can never connect must not sit there
looking healthy — that looks exactly like an empty queue:

```ts
await assertRedisReachable(redis, { url: env.REDIS_URL, timeoutMs: 5_000 });
```

It takes the URL and parses it so the error can name the host. It never prints the password.

The client **singleton** stays yours, for the same reason the pool's does: a package that holds
it decides when your process can exit.

`ioredis` is an optional peer, behind the `/redis` subpath, so importing `@gusnips/server` never
installs it.

## What this package does not ship

Each of these was measured, not assumed.

- **Your error codes.** Six backends' factory tables hold 46 distinct names and exactly nine
  appear in all six. The codes are an API's vocabulary. This package ships the shape, the wire
  format and the mask; the names stay with the product that speaks them.
- **The code→status map, and a list of HTTP statuses.** Both are one object literal in your repo,
  and writing them there is what makes `satisfies` catch a code you forgot. A helper wrapping
  them would add a call and subtract nothing.
- **A `messageKey` catalog.** The server owns the condition and the `params`; the client owns the
  prose.
- **A logging library, a transport, or an alerting client.** The measured gap between 60 lines
  of `console.log(JSON.stringify(...))` and a real logging library is the error serializer, and
  the standard one ships the same copy-loop this package exists to remove — so `createLogger` is
  those 60 lines with the serializer fixed, and nothing else. `errorResponse` returns `kind` and
  `errorHandler` takes `onUnexpected`, so alerting is yours to route.
- **A styled error page.**

## Rules it will not let you break

- A 429 raised with no wait does not compile.
- A code→status map that is not `as const` is refused.
- A code outside your map, or a message key outside your union, does not compile.

## Develop

```bash
bun install
cd server && bun run test
```
