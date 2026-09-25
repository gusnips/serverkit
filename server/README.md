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
none. Both places get whole seconds, never below zero: `1.2` goes out as `2`, and a window that
already reset (`-3`) as `0`.

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

**Recognized by shape also means ANY failed parse reads as the caller's mistake, including a
parse of your own data.** A response checked against its schema, or a database row parsed on the
way out, throws the same error as a bad request body. Let it escape and the caller gets a 400
naming your response's own fields, for a bug that is yours. Check your own data with
`safeParse`, and raise a failure as your internal 500, with the parse error as its `cause`. One
adopter had it on every operation it served.

The answer's `messageKey` is typed as the `MessageKey` you bound, so `errorResponse(err).body.error`
fits a slot of your own, like a stream's error frame or a failed job's record, with no cast.

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
An error passed on its own, `logger.error("drain failed", err)`, is written under `error` too.

**What it keeps off an error is an allow-list**, and that is the one thing here that exists
because of an incident rather than because of duplication. An SDK hangs its own INPUTS off the
error it throws: a payment vendor's signature-verification error carries the unparsed webhook
body and the signature, a Redis client puts the AUTH password in `command.args`, and a Postgres
`DatabaseError` carries statement text with its literals in it. A loop over own properties copies
all of that, and a webhook route is unauthenticated by definition — so anyone on the internet
could choose what went into the log. The list admits 4 of that payment error's 25 properties, and
it covers the `cause` chain, including a link that is not an `Error`.

**It hides the secrets it can recognize.** A key ending in `authorization`, `cookie`, `password`,
`secret`, `token` or `apiKey` gets `"[redacted]"` instead of its value, at any depth, so logging a
request's headers does not print the `Authorization` one. Plurals count too (`apiKeys`, `secrets`),
except `tokens`, which in a log is a count. In every string, the message and an
error's stack included, `Bearer …` and the `user:password@` in a URL are replaced too. The key has
to END with the word, so `apiKeyId`, `inputTokens` and `tokenId` still print. You cannot turn this
off. To hide more, add your own rules:

```ts
const logger = createLogger({
  level: process.env.LOG_LEVEL,
  redact: { keys: /cpf$/i, values: [[/\bacme_[\w-]+/g, "[redacted]"]] },
});
```

They run beside the defaults, not instead of them. A value pattern needs the `g` flag, because
without it only the first match in each string is hidden; `createLogger` throws if one is missing.

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
import {
  apiSecureHeaders,
  corsAllowList,
  errorBoundary,
  errorHandler,
  notFoundHandler,
  requestLogger,
} from "@gusnips/server/hono";

app.use(requestLogger({ logger })); // first, so it times and sees everything under it
app.use(apiSecureHeaders()); // before errorBoundary, or a plain-object throw loses them
app.use(corsAllowList([env.APP_URL, env.SITE_URL]));
app.use(errorBoundary);
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

### The headers on every answer

`apiSecureHeaders()` is Hono's `secureHeaders`, set for an API that answers JSON: HSTS for two
years with `preload`, `X-Frame-Options: DENY`, and a CSP that loads nothing,
`default-src 'none'; frame-ancestors 'none'`. For a route that serves a page, pass overrides. A CSP
directive you add keeps the others.

**Mount it before `errorBoundary`.** It writes its headers after the route has answered, and a
throw that is not an `Error` skips that step in every middleware inside the boundary. Seven APIs
in the fleet had it inside, so a plain-object throw answered 500 with none of the headers.

Its `Cross-Origin-Resource-Policy: same-origin` does not block your web app. CORP applies to an
`<img>` or a `<script>` from another origin. A `fetch` from your app is a CORS request.

`corsAllowList(origins)` answers only the origins you list, compared exactly:

- Each entry is reduced to its origin at boot. A blank entry is skipped, and anything that is not
  an origin, such as `localhost:5173` or `*`, throws.
- A page can always read `Retry-After` and `X-Request-ID`. A browser hides both unless CORS lists
  them.
- No `Access-Control-Allow-Credentials` unless you pass `credentials: true`. A Bearer token does
  not need it. A client that sends `credentials: "include"` does.
- A browser keeps a preflight for 10 minutes, where the default is 5 seconds.
- `.has(origin)` gives the same answer, for a door that reads `Origin` itself, such as MCP.

Under those, put every check that needs only the headers before Hono's `bodyLimit`. It reads a
chunked body whole before the next middleware runs, so a refusal placed after it has already paid
for the upload:

```ts
app.use("/v1/*", addressLimit); // rateLimit keyed on the client's address
app.use("/v1/*", requireUser);
app.use("/v1/*", bodyLimit({ maxSize: 1024 * 1024 })); // from hono/body-limit
```

A webhook's signature covers its body, so there `bodyLimit` goes right after the address limit.
It hands on the same bytes it read, so the signature still verifies. And give `Bun.serve` a
`maxRequestBodySize`: without one, Bun takes a body of up to 128 MiB (measured on 1.3.8 and 1.4.2).

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

**It reads a `date` column as the day.** `'2026-09-23'` comes back as the string `"2026-09-23"`.
node-postgres would give you a Date at midnight in the machine's own time zone, so the same row
is a different moment on every server, and on one east of UTC `toISOString()` gives the day
before. A `timestamptz` still comes back as a Date, because it is a real moment. This applies to
this pool only; pass `dateColumns: "date"` to get Dates back.

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

### A retry that does not run twice

A client that timed out on a write cannot tell whether the write happened. If it sends a key of
its own, `Idempotency-Key: 5f0c…`, the retry gets the first answer back instead of sending a
second message or charging a second time. Add the table in a migration:

```sql
CREATE TABLE app.idempotency_keys (
  owner text NOT NULL,
  key_hash text NOT NULL,
  fingerprint text NOT NULL,
  lease uuid NOT NULL,
  answer json,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, key_hash)
);
CREATE INDEX idempotency_keys_created_at_idx ON app.idempotency_keys (created_at);
```

Then run each write through it:

```ts
import { createIdempotency } from "@gusnips/server/pg";

const idempotency = createIdempotency(pool, {
  table: "app.idempotency_keys",
  onError: (error) => logger.error("idempotency store failed", { error }),
});

const outcome = await idempotency.run(
  { owner: workspaceId, operation: "send_message", key: c.req.header("idempotency-key") },
  input,
  () => sendMessage(input),
);
if (outcome.kind === "running")
  throw errors.conflict("A request with this key is still running", { retryAfterSecs: 2 });
if (outcome.kind === "mismatch")
  throw errors.keyReused("This key was already used for a different request. Send a new one.");
return c.json(created(outcome.answer), 201);
```

- **With no key, it just runs.** Nothing is stored.
- **A key that is still running answers 409, with a wait.** Waiting fixes it.
- **A key used for other input or another operation answers 422**, as the IETF
  `Idempotency-Key` draft says. Waiting never fixes it, so it must not share a status with the
  409 a client is meant to retry.
- **Check who may call the operation before `run`.** A replay hands back a stored answer, and
  it must never reach a caller who could not get it now.
- **A throw lets the key go**, so a retry with the same key runs again.
- **A failed save still answers.** The work happened, so `onError` gets the failure and the
  client gets its answer. Its retries see "running" until `abandonedSecs` passes, then run again.
  That is the one path that can still run twice, which is why `onError` is required.
- **A claim nobody answered is taken over after 15 minutes** (`abandonedSecs`), because the
  process that made it died. Set it well past your slowest operation.
- **An MCP door takes the key as an argument.** A tool call has no headers of its own, so add an
  optional `idempotencyKey` to the tool's input schema and pass it as `key`.
- **Delete old answers** once an hour or once a night: `await idempotency.prune()`.

`owner` can be a `uuid` column that references your workspaces, if you want a deleted
workspace's keys to go with it.

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

**It makes the error handler impossible to forget.** Without one, a failed connect prints a bare
stack to stderr through ioredis's own `console.error` and reaches the app's logger not at all — so
the one signal that a dependency has stopped answering lands outside the place an operator is
already looking. `onError` is a required field, not an option. Four backends were measured for
this: all four wrote the listener, all four wrote a comment saying it is not optional, and the
function around it was byte-identical in every one.

**Their stated reason for it is wrong, which is worth knowing before you copy it again.** All four
say an EventEmitter with no `error` listener throws, so a blip becomes a process exit through a
crash handler. True of an EventEmitter, false of ioredis: `silentEmit` checks the listener count
and, finding none, logs and returns without ever emitting. Measured on ioredis 5.10.1 under bun
1.3.8 and node 22 — the process survives and `uncaughtException` never fires. `createPgPool`'s
`onIdleError` is NOT the same case, checked the same way rather than assumed: `pg-pool` calls
`pool.emit("error", err, client)` with no listener-count guard, so there the listener really is what
stands between an idle-client error and a crash. One library's sentence was copied onto another.

**It defaults `maxRetriesPerRequest` to `null`, and that is the opposite kind of default from
`createPgPool`'s.** There the default makes an unbounded wait bounded; here it makes commands
wait forever — because BullMQ requires it, since its blocking reads must never be cut short by a
retry limit. So the default is right and it has a consequence worth saying once:

**every read on this connection needs its own bound.** A `ping`, a cache lookup, a limiter
check, a `queue.add()` — with Redis down, each waits rather than failing. Pass
`maxRetriesPerRequest: 3` for a connection that serves ordinary commands instead of BullMQ's.

**A URL with options after its `?` is refused.** ioredis lets those beat the options you pass,
and reads each as a string: `?maxRetriesPerRequest=7` replaces the `null` BullMQ needs, and
`?enableOfflineQueue=false` is the string "false", which ioredis reads as on. Pass them to
`createRedis` instead, such as `family: 6`.

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
await assertRedisReachable(redis, {
  url: env.REDIS_URL,
  hint: "Start it (the dev compose runs one) or fix REDIS_URL.",
});
```

It takes the URL and parses it so the error can name the host. It never prints the password.

`hint` is the sentence a package cannot write for you. The generic half says what failed and
its likely cause; the fix is local, and "the dev compose runs one" names a command that exists
in one repo and not the next. Three backends wrote this gate: two said "check REDIS_URL" and the
third named the tool, and the third is the only one a reader can act on without knowing the repo
already.

Close it with `quitRedis` when the process stops:

```ts
{ name: "redis", run: () => quitRedis(redis) }
```

A bare `redis.quit()` can hang the drain in two ways. If Redis is down and a command is still
waiting to be sent, `quit()` waits for that command first, and it is never sent. If Redis is frozen,
`QUIT` gets no answer. Either way the steps after it, Postgres included, never run, and your process
manager kills the process at its timeout. `quitRedis` sends `QUIT`, waits up to a second, then
closes the socket. It never throws.

The client **singleton** stays yours, for the same reason the pool's does: a package that holds
it decides when your process can exit.

`ioredis` is an optional peer, behind the `/redis` subpath, so importing `@gusnips/server` never
installs it.

## Background jobs

Queues and workers for BullMQ, on the connection `createRedis` gives you:

```bash
bun add bullmq
```

```ts
import {
  createQueue,
  createWorker,
  retryStalledFailures,
  wireDeadLetter,
  type DeadLetter,
} from "@gusnips/server/bullmq";

const onError = (error: Error) => logger.error("[bullmq] connection error", { error });
const reports = createQueue<{ userId: string }>("reports", { connection: redis, onError });
const deadLetters = createQueue<DeadLetter>("dead-letters", { connection: redis, onError });

const worker = createWorker<{ userId: string }>("reports", buildReport, {
  connection: redis,
  onError,
  concurrency: 5,
});
const flush = wireDeadLetter(worker, deadLetters, { onError });
await retryStalledFailures(reports);
```

- **Finished jobs are deleted.** BullMQ keeps them forever unless told otherwise, and one backend's
  Redis grew to about 16 GB before anyone noticed. Completed jobs stay for a day, 200 at most.
  Failed ones stay for a week, 1,000 at most. The worker sets the same limits, so a job a script
  adds through a plain `new Queue` is deleted too.
- **A job whose worker dies runs again after 30 seconds, twice at most.** For a job that must never
  run twice, such as one that sends an email, pass `maxStalledCount: 0` and give its jobs
  `attempts: 1`.
- **`wireDeadLetter` records every job that failed for good**, in a queue of its own. Run a worker
  on that queue to log each record or tell a person. It asks BullMQ whether the job will run again,
  instead of counting attempts, so it also records a job that threw `UnrecoverableError` or
  stalled too often on its first attempt. Three of the five dead letters it replaces missed those.
  In your shutdown, call `flush()` after the worker closes and before Redis does.
- **`retryStalledFailures` re-runs the jobs a deploy killed.** Two deploys during one long job use
  up its two retries. It only matches the reason BullMQ writes, so a job that failed with the word
  "stalled" in its own error stays failed. Never call it on a queue whose jobs must run at most
  once.
- **`CAPPED_EXPONENTIAL`** retries after about 5, 10 and 20 seconds, and so on up to 120:
  `backoff: { type: CAPPED_EXPONENTIAL }`.
- **`removeLeftoverJob`** is for jobs you add under an id you chose. BullMQ skips the add, with no
  error, while a finished job with that id is still kept.

Recurring jobs come from one table, synced on every boot:

```ts
await syncJobSchedulers(maintenance, {
  "session-prune": { pattern: "20 4 * * *", tz: "UTC" },
  "job-reaper": { every: 2 * 60_000 },
});
```

A cron pattern without a time zone does not compile, because without one it runs on the server's
clock. An entry you delete or rename stops running: the sync removes every scheduler on the queue
that the table does not name, so give the table a queue of its own.

`bullmq` is an optional peer, behind the `/bullmq` subpath.

## A rate limit

```ts
import { memoryWindowStore } from "@gusnips/server";
import { rateLimit } from "@gusnips/server/hono";

app.use(
  "/app/*",
  rateLimit<AppEnv>({
    scope: "app",
    store: memoryWindowStore(),
    limit: 300, // requests a minute, per user
    windowMs: 60_000,
    key: (c) => c.get("userId") ?? null,
    refuse: (hit) => errors.rateLimit(hit.retryAfterSecs),
  }),
);
```

The 301st request in a minute gets your own 429, through your `onError`, and `Retry-After` says
how many seconds are left in that minute. Windows start on the clock's minute, so the number is
exact rather than a constant. A `key` that returns `null` lets the request through uncounted.

**`key` must be something the server checked.** Before auth, that is the client's address. After
auth, it is the verified user, key or account, never the raw bearer token: a limiter that counts
the token counts whatever string the caller sends. On one backend, 300 requests from one address
with a new random token each were refused 0 times.

### The client's address

A limit in front of sign-in counts per address, and the address has to be one the caller cannot
make up:

```ts
import { ipSubject, memoryWindowStore } from "@gusnips/server";
import { bunPeer, clientIp, rateLimit } from "@gusnips/server/hono";

app.use(clientIp({ peerOf: bunPeer }));
app.use(
  "/auth/*",
  rateLimit<AppEnv>({
    scope: "pre-auth",
    store: memoryWindowStore(),
    limit: 3_000,
    windowMs: 60_000,
    key: (c) => ipSubject(c.get("clientIp")),
    refuse: (hit) => errors.rateLimit(hit.retryAfterSecs),
  }),
);
```

- **The socket first.** `clientIp` reads the last `X-Forwarded-For` hop only when the socket peer
  is loopback, which is your proxy on the same box, because that hop is the one the proxy wrote.
  From anywhere else the peer is the client, and its `X-Forwarded-For` is its own claim. So an API
  that also answers on its public interface cannot be handed a made-up address. `X-Real-IP` is
  never read: by its documented default, Caddy passes a client's own copy through.
- **On a Worker or on Fly**, pass the edge's header instead: `clientIp({ header:
"cf-connecting-ip" })`. Not on a box behind a proxied Cloudflare record, where anyone who finds
  the box's address can send that header too.
- **`null` when no address can be trusted**, never `"unknown"`. A shared `"unknown"` window is one
  any caller can fill for everyone. A `key` of `null` lets the request through uncounted; write
  `?? "unknown"` if you would rather count those together.
- **`ipSubject` counts an IPv6 address by its /56**, the network one customer is usually given.
  Counted by the full address, one customer has 2^64 fresh windows. IPv4 is left as it is.
- **`bunPeer`, not `hono/bun`.** It reads the address `hono/bun`'s `getConnInfo` reads, from the
  server Bun hands `fetch`, without importing `hono/bun`. That import reads the `Bun` global as
  it loads, so an app file that has it cannot load at all in a test run under Node. In a test's
  `app.request()` there is no server, so `clientIp` is `null` and the limiters let it through. On
  another runtime, pass its own `getConnInfo`: a `peerOf` that throws reads as no peer.

**The memory store counts per process** and starts again on every deploy. That is right for a
burst limit in front of an auth round trip. It tracks 50,000 windows at most, and past that it
refuses new ones, which `refuse` gets as `hit.outcome === "shed"`: that caller hit no limit, so
your 429 can say the server is busy instead. It clears the closed windows once per window, not
once per request. The copies it replaces did it once per request, which cost about 3.8 ms each
on a full map, so a flood of spoofed addresses could keep a process busy doing nothing else.

**A limit a plan sells goes in Redis**, so it holds across a restart and a second process:

```ts
import { createRedis, redisWindowStore } from "@gusnips/server/redis";

// Its own connection, one that fails at once when Redis is down.
const limitsRedis = createRedis({
  url: env.REDIS_URL,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 1_000,
  onError: (error) => logger.error("[redis] limiter connection", { error }),
});

app.use(
  "/v1/*",
  rateLimit<AppEnv>({
    scope: "api",
    store: redisWindowStore(limitsRedis, { timeoutMs: 500 }),
    whenStoreFails: "allow",
    logger,
    limit: (c) => planOf(c.get("user")).requestsPerMinute,
    windowMs: 60_000,
    key: (c) => c.get("user").accountId,
    refuse: (hit) => errors.rateLimit(hit.retryAfterSecs),
  }),
);
```

- **`whenStoreFails` is required for a store that can fail, and it has no default.** Say
  `"allow"` for a limit that guards a promise, like a plan's requests per minute: refusing every
  paying caller over a Redis blip trades a real outage for a limit nobody was hitting. Pass your
  503 for one that guards a bill or a stranger's inbox, like a keyless demo or a form that sends
  mail: `whenStoreFails: () => errors.unavailable("…")`. Either way the failure is written to
  `logger`, with the scope and never the subject.
- **Give it its own connection.** Three limiters in the fleet said "fails open" and hung instead,
  because the connection `createRedis` makes by default waits for Redis to come back, and so did
  every request behind them. `timeoutMs` is required as the backstop. The connection above fails
  in a few milliseconds, so the backstop never runs.
- One MULTI counts the request and re-arms the key's expiry, so no key outlives its window. Keys
  start with `rl:`; pass `prefix` to change that.

`hitWindow(store, key, { limit, windowMs })` is the same count without Hono, for a Worker, a job
or an MCP tool. It answers `{ outcome, allowed, retryAfterSecs, … }` and never throws for a limit.

## A URL somebody else gave you

A webhook endpoint, a link to read, an image to fetch: each is a customer telling your server to
send a request. Your server shares a network with Postgres, Redis and the cloud metadata service
at 169.254.169.254, so an unchecked URL lets anyone who can save one aim it inward.

```ts
import { checkUrlShape } from "@gusnips/server";

checkUrlShape("https://169.254.169.254/latest/meta-data/");
// → { ok: false, reason: "private-address" }
```

It answers with a result, not a throw, so the 400 is in your words. The reasons are `invalid`,
`scheme`, `credentials`, `port`, `internal-name` and `private-address`.

- **Only `https:` by default.** A reader of pasted links passes
  `{ schemes: ["http:", "https:"] }`.
- **`ports: [80, 443]`** is the smaller blast radius when nothing needs more. DNS can move a
  host; it cannot move a port.
- **`allowLoopback: true`** lets `localhost`, 127.0.0.0/8 and `::1` through for a test, and
  nothing else. Never a private range, never the metadata service.

Twelve backends wrote this check. The most-copied version let carrier-grade NAT through, and
another judged `::ffff:127.0.0.1` safe once the URL parser had rewritten it as `::ffff:7f00:1`.
`isPublicAddress` accepts only global addresses, so a spelling nobody thought of is refused
rather than waved through.

**Follow a redirect yourself, and check every hop.** With `redirect: "follow"`, fetch has already
sent a request to each hop by the time you can check where it ended:

```ts
const hop = nextHop(url, response, { method: "POST", headers });
// null: not a redirect. { ok: false, reason }: refuse. Otherwise the next request:
// hop.url, hop.method, hop.headers, and hop.dropBody when a 302 turned a POST into a GET.
```

It rewrites the method the way fetch does, and it keeps `Authorization`, `Cookie` and
`Proxy-Authorization` from reaching another origin.

**Read the answer with a limit.** `readBounded(response.body, 1_000_000)` stops at a million
bytes and cancels the rest. It never trusts `Content-Length`. When `truncated` is true, the body
was longer, and a caller that needs all of it (an image, a JSON document) refuses.

In a Cloudflare Worker, that is the whole check: a Worker cannot resolve a name, and the network
behind its `fetch` is not your box's. On a server, a name still has to be resolved, and the
request sent to the address you checked rather than to whatever DNS answers a moment later.
That is `/node`:

```ts
import { fetchPublic } from "@gusnips/server/node";

const result = await fetchPublic(endpoint.url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(event),
  maxRedirects: 0,
  signal: AbortSignal.timeout(10_000),
});
if (!result.ok) return refuse(result.reason); // your words, as above
result.response.status; // a real Response
```

- **It resolves the name once and refuses it if any answer is private.** A name with one public
  and one private record is refused as a whole. Then it sends the request to one of the addresses
  it checked, with the name in the TLS check and in `Host`. Checking a name and then calling
  `fetch` resolves it twice, and a DNS server that changes its answer in between wins.
- **It follows up to 5 redirects and checks each one before sending it.** `maxRedirects: 0` hands
  a redirect back as the answer, which is what a webhook wants.
- **`signal` is required.** It bounds the DNS lookup, the connection, the wait and the body.
- **It tries another address only when one refused the connection.** After a timeout it stops:
  the first address may have received the webhook, and the next would deliver it twice.
- **A name DNS does not know is `unresolvable`. A DNS lookup that fails throws**, because telling
  a customer their host does not exist when your resolver is down names the wrong cause.
- **The body is decoded**, so `readBounded` counts the bytes that come out. Ten megabytes of
  gzipped zeros is ten kilobytes on the wire.

Check once when the URL is saved, with `resolvePublic`, so a bad one gets a 400 right away.
`fetchPublic` checks again when it sends, because DNS can change in between.

**Run it on Bun 1.4.2 or later, or on Node 22.** Bun 1.3.8 checks the certificate against the
`Host` header rather than the name it is given, so an https URL on a port other than 443 fails.
It also sends a request a second time on its own when a reused connection is reset.

## A webhook

A webhook URL is public, so anyone can POST to it. The signature is how the receiver tells your
delivery from a forgery.

```ts
import { signWebhook } from "@gusnips/server";

const signature = await signWebhook({ secret: endpoint.secret, body });
// → "t=1700000000,v1=5f1c…", sent as your own header, such as x-acme-signature
```

Receiving one:

```ts
import { verifyWebhook } from "@gusnips/server";

const verdict = await verifyWebhook({
  secrets: [env.WEBHOOK_SECRET],
  header: c.req.header("x-acme-signature"),
  body: await c.req.text(),
});
if (!verdict.ok) throw errors.badSignature(); // log verdict.reason; do not send it back
```

- **Two formats.** `signWebhook` and `verifyWebhook` use one header, the format Stripe uses.
  `signStandardWebhook` and `verifyStandardWebhook` use Standard Webhooks: three headers, the
  format Supabase Auth's hooks send.
- **A delivery signed more than five minutes ago is refused**, however well signed, so a captured
  one cannot be sent again. `toleranceSecs` changes the limit. Sign each attempt, not each event,
  or a retry arrives already too old.
- **`secrets` is a list**, so a rotation is `[env.SECRET, env.OLD_SECRET]`. An unset one is
  skipped. When none is set, the answer is `no-secret`, never a pass.
- **`body` is the raw text.** Parse it after it passes: JSON parsed and written out again is a
  different string, and its signature never matches.
- **Every `v1` signature in the header is tried.** Supabase Auth sends one per secret it holds,
  joined by `", "`.

`newWebhookSecret()` makes a secret both formats accept: `whsec_` and 24 random bytes.

Another vendor's format is one line on the same two functions. GitHub's:

```ts
const expected = `sha256=${await hmacSha256(env.GITHUB_WEBHOOK_SECRET, body, "hex")}`;
if (!safeEqual(c.req.header("x-hub-signature-256") ?? "", expected)) throw errors.badSignature();
```

`hmacSha256` throws on an empty key and `safeEqual` answers `false` when either side is empty, so
an unset secret cannot let a request through.

### Sending one, and trying again

```ts
import { nextDeliveryStep } from "@gusnips/server";

const step = nextDeliveryStep(response, delivery.attempts + 1);
// → { outcome: "retry", afterSecs: 60 }
```

`response` is what the receiver answered, or `null` when nothing came back: a refused connection, a
timeout, or DNS failing. The second argument is the attempt that just ran, counting from 1.

| The receiver answered            | The step                                                       |
| -------------------------------- | -------------------------------------------------------------- |
| 2xx                              | `delivered`                                                    |
| 408, 425, 429, 5xx, or no answer | `retry` after `afterSecs`, until the fifth attempt `exhausted` |
| 3xx                              | `failed`, `reason: "redirected"`                               |
| any other 4xx                    | `failed`, `reason: "refused"`                                  |

- **A 4xx is final.** The receiver's code answered on purpose, and the same body gets the same
  answer. Six of seven senders tried it again. What this gives up is a 404 while their
  deploy swaps routes, which is rarer than a 502 and shows in the delivery log.
- **A redirect is final.** A webhook follows none, because the new address was never checked, so
  the next attempt would get the same redirect. Ask the customer to register the final URL.
- **The wait doubles from 30 seconds**: 30, 60, 120 and 240, then the fifth attempt is the last.
  `{ attempts, baseSecs, maxWaitSecs }` in the third argument changes that.
- **A `Retry-After` longer than the ladder's wait is believed**, in seconds or as a date. No
  sender read it before. It is capped at an hour (`maxWaitSecs`), so a receiver asking for three
  hours gets an attempt each hour instead of being given up on.
- **Schedule the retry with `afterSecs`, not with your queue's own backoff**, or the two disagree
  and the row's "next attempt" is wrong. In BullMQ, delay the job by hand:
  `await job.moveToDelayed(Date.now() + step.afterSecs * 1000, token); throw new DelayedError();`.
- **Keep the attempt count on the delivery row.** A job delayed by hand keeps `attemptsMade` at 0
  (measured on BullMQ 5.81.5), so `job.attemptsMade + 1` would say "first attempt" forever and the
  delivery would never stop.

**A breaker counts deliveries that failed for good, never attempts.** A receiver down for ten
minutes should not use up ten failures on one event while it is still being retried. So count a
`failed` step, and turn the endpoint off in one statement:

```sql
-- $1 is the endpoint, $2 how many failures in a row turn it off
UPDATE webhook_endpoints
   SET consecutive_failures = consecutive_failures + 1,
       enabled = consecutive_failures + 1 < $2
 WHERE id = $1 AND enabled
RETURNING NOT enabled AS tripped
```

`tripped` is true for exactly one failure, so the mail saying "we turned your endpoint off" goes
once. Measured on Postgres 18 with 20 failures at once and a limit of 10: one trip, with the count
at 10. Reading the count and then writing it, as two senders do, kept 1 of the 20 and never tripped.
A `delivered` step resets it:
`UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures > 0`.
With supabase-js, put the statement in a Postgres function and call it with `.rpc()`, because
`.update()` cannot add one to a column.

## A secret you store

An OAuth token or a mailbox password in your database is one leaked backup away from being
somebody else's. Seal it before you store it:

```ts
import { createSealer } from "@gusnips/server";

const vault = createSealer({ current: "v1", keys: { v1: env.SEAL_KEY } });

const sealed = await vault.seal(refreshToken); // "v1.Xq3…", safe to store
await vault.open(sealed); // refreshToken
```

- **A key is 32 random bytes in base64.** Make one with `openssl rand -base64 32`. A key of any
  other length is refused when the sealer is created, so a wrong one stops the boot instead of the
  first sign-in.
- **The `v1` at the front names the key.** To change keys, add the new one, point `current` at
  it, seal the stored values again, then remove the old key. Until you remove it, both open.
- **`open` throws a `SealError`**, whose `reason` is `malformed`, `unknown-key` or
  `did-not-open`. The last one has two causes that encryption cannot tell apart: this process
  holds a different key from the one that sealed the value, or the value was changed.
- It is AES-256-GCM with a random 12-byte IV and a 16-byte tag, and it runs in a Worker.

Rows sealed under a passphrase with Node's `scryptSync(passphrase, salt, 32)` open with the key
`/node` derives the same way:

```ts
import { scryptSealKey } from "@gusnips/server/node";

const vault = createSealer({
  current: "v1",
  keys: { v1: await scryptSealKey(env.CREDENTIALS_ENCRYPTION_KEY, "acme-credentials-v1") },
});
```

## A link that proves who it is for

An unsubscribe link, an OAuth `state`, an approval link: your server writes a token, hands it to a
person, and reads it back later with no session behind it. The signature proves you wrote it.

```ts
import { signToken, verifyToken } from "@gusnips/server";

const token = await signToken({ secret, purpose: "unsubscribe:v1", payload: userId });
// → "dXNlcl80Mg.Xq3…", safe in a URL

const verdict = await verifyToken({ secret, purpose: "unsubscribe:v1", token });
if (!verdict.ok) return c.html(linkNotValidPage); // one page for every reason
verdict.payload; // userId
```

- **`purpose` is mixed into the key.** A token made for one purpose never verifies for another,
  and the secret itself never signs, so a service key you already hold can be the secret.
- **`ttlSecs` makes it expire.** Leave it out only for a link that must work forever, such as
  unsubscribe: the button sits in old mail, and old mail is where people look for it.
- **It is signed, not encrypted.** Anyone holding the token can read the payload. For structured
  data, pass `JSON.stringify(data)`, and parse it after it verifies.
- **`reason` is `malformed`, `bad-signature` or `expired`.** `expired` is only said of a token you
  signed, so a page that says "this link expired, ask for a new one" is telling the truth.

Without `ttlSecs`, a token is `<base64url(payload)>.<signature>`, keyed by the HMAC of the secret
and the purpose. Links you signed that way by hand keep verifying after you switch.

## An MCP door

Serve your API's operations to AI agents over MCP, the protocol agents use to call tools, with the
same errors and limits as your REST routes.

```bash
bun add @modelcontextprotocol/sdk
```

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { hitWindow, memoryWindowStore } from "@gusnips/server";
import { mcpRoutes, registerOperation } from "@gusnips/server/mcp";

const toolCalls = memoryWindowStore();

function buildMcpServer(c: Context<AppEnv>) {
  const server = new McpServer({ name: "acme", version: "1.0.0" });
  const userId = c.get("userId");
  for (const op of OPERATIONS)
    registerOperation(server, op, {
      errorResponse,
      logger,
      requestId: c.get("requestId"),
      deps: () => ({ userId }),
      // Once per tool call. One POST can carry many.
      beforeCall: async () => {
        const hit = await hitWindow(toolCalls, userId, { limit: 60, windowMs: 60_000 });
        if (hit.outcome === "limited" || hit.outcome === "shed")
          throw errors.rateLimit(hit.retryAfterSecs);
      },
    });
  return server;
}

app.use("/mcp/*", requireApiKey);
app.route("/", mcpRoutes("/mcp", buildMcpServer, { allowedOrigins: new Set() }));
```

An operation is `{ name, description, inputSchema, run(deps, args) }`, plus an optional `title`
and `annotations`. If your REST routes already run operations of that shape, the same list serves
both doors.

- **A tool call answers what the REST route answers.** A success is `{ data }`, as one text block.
  A failure is the same `{ error }` body your `errorResponse` gives REST, marked `isError`. Pass
  `present` to answer a success differently, for example with an image first. It gets the call's
  own `deps`, so an image the operation handed back on the side stays with that call, and it may
  be async. A throw in `present` answers the call as failed after the work is done, so catch what
  is only nice to have.
- **A tool handler never throws.** The MCP SDK answers a throw with the error's own message, so
  `connect ECONNREFUSED 10.0.0.5:5432` reaches the agent and no log line sees it. Three of eight
  backends shipped that. `registerOperation` catches every failure: a 5xx and an unexpected throw
  are logged with the raw error, and an unexpected throw is masked, as on REST. `onUnexpected` is
  where an alert goes. If you register a tool yourself, return `toolError(err, name, door)` from its
  `catch`.
- **Your limit goes in `beforeCall`, not on the route.** One POST can carry a batch of tool calls,
  and the SDK runs every one of them. A limit on the route counts the POST, so 50 calls cost one.
  `beforeCall` runs before each call. Throw your 429 there and only that call is refused. It is
  required, so a door with no limit says `null`.
- **Pass the zod object, made `.strict()`, not its `.shape`.** Given a shape, the SDK builds a loose
  object and quietly drops an argument the agent made up. Given the strict object, it refuses the
  call and names the key. A `.shape` does not compile here.
- **Only POST is served.** This door keeps no sessions. A GET gets a 405 instead of an event stream
  that nothing writes to and that stays open until the server's idle timeout.
- **A web page must be on `allowedOrigins`.** The MCP spec asks servers to check `Origin`. A request
  with no `Origin`, from an agent or a script, always goes through. An empty set refuses every web
  page.
- `build` runs once per request, and the server it returns is closed after the answer.

**Guard `"/mcp/*"`, not `"/mcp"`.** The door answers `/mcp` and `/mcp/`. In Hono, `"/mcp"` guards
only the first, so `/mcp/` would skip your API key check. `"/mcp/*"` guards both. Mount the door
with `app.route("/", …)`, as above: mounted at `/mcp`, Hono serves only one of the two. Five of
eight backends said in a comment that they served both, and answered `/mcp/` with a 404.

We tested the SDK at 1.29.0 and 1.30.1, and Hono at 4.12.26 and 4.13.8. `@modelcontextprotocol/sdk`
is an optional peer, behind the `/mcp` subpath, and the subpath imports nothing from Node.

## A reference for your API

An OpenAPI document is the one file that docs sites, client generators and agents read to learn
your routes. Build it from the list of operations your API already mounts:

```ts
import { z } from "zod";
import {
  buildOpenApi,
  createOpenApiResponder,
  type OpenApiOperation,
} from "@gusnips/server/openapi";

const OPERATIONS: OpenApiOperation[] = [
  {
    name: "pair_number",
    method: "post",
    path: "/numbers/:id/pair",
    tag: "Numbers",
    summary: "Pair a number",
    input: z.object({ id: z.string(), method: z.enum(["qr", "code"]) }).strict(),
    response: z.object({ status: z.string() }),
  },
];

const reference = createOpenApiResponder(() =>
  buildOpenApi(OPERATIONS, {
    info: { title: "Acme API", version: "1.0.0" },
    origin: "https://api.acme.test", // from your config
    basePath: "/v1",
    tags: [{ name: "Numbers", description: "The phone numbers on your account." }],
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    errors: { 400: "The input is wrong.", 401: "The key is missing or wrong." },
  }),
);

app.get("/openapi.json", (c) => reference(c.req.query("lang")));
```

`POST /v1/numbers/{id}/pair` then takes `id` in the path and `method` in a JSON body, and answers
`{ data: { status } }`. A GET or DELETE takes its fields in the query string instead.

- **`origin` comes from config, never from the request.** Behind a proxy every request arrives on
  `127.0.0.1`. Four of five APIs built their reference from the request, so it sent every
  "Try it" button, every generated client and every agent to the reader's own machine.
- **`basePath` is required, even when it is `""`.** The server and the path together are the
  route. One API left out its `/v1`, so every path in its reference answered 404.
- **An operation id is used once.** By default it is the operation's `name`. When one operation is
  mounted on two paths or two methods, give each an `operationId`. A repeat throws: one API
  published the same id five times, and a generated client keeps one of the five.
- **A path slot may carry a field of another name.** `params: { numberId: "id" }` sends `numberId`
  in `/numbers/:id`. List fields the route fills in itself, such as a `type` the path decides, in
  `fixed`, and they stay out of the reference.
- **Every refusal points at one `ApiError` schema**, the `{ error }` envelope. A 409, a 429 and a
  503 also document `Retry-After`, because those are the ones this package's own code sends it on.
  Pass `errorCodes` with every code your API answers with, and the schema lists them, so a
  generated client can switch on one. `errors` on the options is what every operation can
  answer; `errors` on one operation adds what only it can, such as a 504 on a call that waits
  on someone else.
- **`meta` sits beside `data`** when you say what it holds: `meta: PageMetaSchema` names it on
  every success, as optional.
- **Schemas are zod 4.4 or later, any other Standard JSON Schema, or plain JSON Schema.** A type
  JSON cannot carry, such as a `Date`, is written as `{}` instead of failing the whole reference.
  A schema that refers to itself throws, because inside the document its `$ref` would point at the
  wrong thing.
- **`mcpTools: true`** also lists each operation that is not `restOnly` under `x-mcp-tools`, once
  per name, so your docs render both doors from one fetch.

To serve other languages, pass one function per language. It gets each English string and returns
the translation:

```ts
const reference = createOpenApiResponder(build, { "pt-BR": (text) => PT_BR[text] ?? text });
```

The title, tag descriptions, summaries and descriptions are translated. Examples, enums, defaults,
names and the MCP tool list stay as written: an example is data your API returns, and agents read
the tools. Each language is built once, on its first request. A `?lang=` you did not list gets the
document as written. To list every string a translation needs, pass a collector to
`translateProse(doc, (text) => (seen.add(text), text))`.

An `x-` field stays as written in every language, because most are data: a scope name, an SDK
method. When one is a sentence, such as an `x-credits` that says "1 credit per page", name it, and
pass the same list to the collector:

```ts
const reference = createOpenApiResponder(build, translations, { proseExtensions: ["x-credits"] });
```

The subpath imports nothing, so it runs in a Worker. zod loads only if your schemas are zod.

## Sending mail

```bash
bun add nodemailer
```

```ts
import { createMailer } from "@gusnips/server/mail";

const mailer = createMailer({
  host: env.SMTP_HOST,
  user: env.SMTP_USER,
  pass: env.SMTP_PASS,
  from: { name: "Acme", address: "no-reply@acme.test" },
  whenDisabled: () => errors.serviceUnavailable("Mail is not set up on this server"),
});

await mailer.send({ to: user.email, subject: "Your code", text: `Your code is ${code}.` });
```

- **With no `host`, mail is off.** `mailer.enabled` is false, and `send` throws the error
  `whenDisabled` returns. A server without mail still starts, and a send says why it failed. Check
  `enabled` first where you would rather skip the send.
- **Each wait is 15 seconds at most**: finding the server, connecting, its first reply, and any
  silence after that. nodemailer's own limits are 2 minutes to connect and 10 minutes of silence,
  and 12 of 13 backends kept them, some inside a request somebody was waiting on. Change it with
  `timeoutMs`. A server that keeps answering, slowly, can still hold one send for longer.
- **With a login, TLS is required.** Port 587 starts in plain text and switches to TLS only when
  the server offers it. If somebody on the network removes that offer, nodemailer sends your
  password in plain text. We saw it happen on nodemailer 6, 7 and 10, on Node and on Bun. Without
  a login, as with a local mail catcher such as Mailpit, plain text is allowed.
- **Port 465 is TLS from the first byte.** nodemailer picks that from the port, so there is no
  `secure` option to get wrong.
- **`text` is required**, even when you send `html`. Spam filters mark down mail without it.
- **`unsubscribeUrl`** writes both unsubscribe headers (below).
- `send` returns the `messageId`, and the addresses the server `rejected` while it took the others.
  It throws when the server refuses the whole message.

Port 587 works on Bun. After STARTTLS, Bun can keep a copy of the encrypted bytes on the plain
socket (Bun #32239), but only while that socket is paused, and nodemailer never pauses it. We
tested Bun 1.3.8 and 1.4.2.

`nodemailer` is an optional peer, behind the `/mail` subpath.

### The unsubscribe headers

```ts
import { listUnsubscribeHeaders } from "@gusnips/server";

listUnsubscribeHeaders(`https://acme.test/unsubscribe?token=${token}`);
// → {
//     "List-Unsubscribe": "<https://acme.test/unsubscribe?token=…>",
//     "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
//   }
```

Together, the two headers turn on the mail app's own unsubscribe button, and Gmail and Yahoo ask
bulk senders for both. nodemailer's `list.unsubscribe` option writes only the first, and its
`comment` form puts the second one inside the first. The second header is written only for an
https link, because the mail provider sends a POST to it. A `mailto:` link is refused. The function
has no dependencies and runs in a Worker too, so its result also fits Resend's `headers`. Make the
token with `signToken`, above.

Your unsubscribe route stays yours. Three rules for it:

- **A GET never unsubscribes anyone.** Mail scanners open every link in a message. Show a page
  with a button, and unsubscribe on the POST.
- **The POST is the one-click button.** The mail provider sends `List-Unsubscribe=One-Click` to the
  same URL, with no cookie. Unsubscribe, and answer 200.
- **A failure on your side is not a bad link.** When your database or auth is down, answer 503 and
  let the person try again. Telling them the link is invalid loses the unsubscribe.

## The environment

Check the environment first thing at boot. A box with a wrong `.env` then stops with a list of
what to change, instead of failing one request at a time:

```ts
import { validateEnv } from "@gusnips/server";

validateEnv(process.env, {
  required: ["DATABASE_URL", "SESSION_SECRET"],
  groups: { SMTP_HOST: ["SMTP_USER", "SMTP_PASS"] },
  secrets: { SESSION_SECRET: 32 },
  fix: "Copy apps/api/.env.example to apps/api/.env and fill it in.",
});
```

With `DATABASE_URL` missing and `SESSION_SECRET` still the example's value, it throws an
`EnvError` whose message is:

```text
The environment has 2 problems:
- These are not set: DATABASE_URL
- SESSION_SECRET looks like a placeholder from .env.example. Put the real secret there.
Copy apps/api/.env.example to apps/api/.env and fill it in.
```

- **Every problem is in one error**, so you fix a box in one edit, not one restart per variable.
- **No value is ever in it.** A connection URL carries a password, and this goes to a boot log.
- **`groups`:** once `SMTP_HOST` is set, `SMTP_USER` and `SMTP_PASS` must be set too. Mail left
  off is fine; mail set up halfway stops the boot.
- **`secrets`** gives each secret the fewest characters it may have, and refuses the shapes a
  placeholder takes: `your-…` (also after a vendor prefix, as in `sk_test_your_…`), `<…>`,
  `…-xxx`, `generate-…`, `change-me` and `dev-only`. A placeholder that boots signs and verifies
  like a real secret, and anyone who has read your `.env.example` can forge with it.
- **A secret that is set is checked, even when its group is off.** Leave `SMTP_HOST` unset with a
  placeholder still in `SMTP_PASS`, and the boot stops. That is on purpose: the spec knows which
  keys go together, not which code reads them, and a webhook route mounted either way still
  verifies with its secret. Delete the line of an integration you do not run.
- **`check`** adds your own rules to the same list. Return a line per problem, with no value in it.
- In a Worker, pass its `env`. `envProblems` returns the same list without throwing, for a test.

## Stopping for a deploy

A process manager stops your process with a signal, and kills it when its timeout runs out. In
between, finish the work in flight and close what it used, in order:

```ts
import {
  bunServerStep,
  createShutdown,
  installProcessHandlers,
  type Shutdown,
} from "@gusnips/server/node";
import { quitRedis } from "@gusnips/server/redis";

// First, before anything that can throw.
let shutdown: Shutdown = createShutdown([], { hardExitMs: 25_000, logger });
installProcessHandlers((reason, code) => shutdown(reason, code), { logger, rejections: "survive" });

// …check the env, open the pool and Redis, start the server…

shutdown = createShutdown(
  [
    bunServerStep(server, { graceMs: 5_000 }),
    { name: "redis", run: () => quitRedis(redis) },
    { name: "postgres", run: () => pool.end() },
  ],
  { hardExitMs: 25_000, logger },
);
```

- **Install the handlers first, and hand them the drain once it exists.** A crash while booting,
  such as a port already taken or a bad env, is the one your log most needs, and the steps need a
  server that does not exist yet. Until the real drain replaces it, the empty one logs the crash
  and exits 1. On Bun 1.4.2 a throw at the top level and a rejected top-level `await` both reach
  the handler.

- **The steps run once, in the order you list them.** Stop taking work first. Close the database
  last, because a request that is still finishing may still query it.
- **A failed step does not stop the rest**, and the process then exits 1, so your process manager
  knows the drain failed.
- **`hardExitMs` bounds the whole drain.** When it runs out, the log names the step that hung and
  the process exits 1.
- **`bunServerStep`** stops taking connections at once and gives the requests in flight `graceMs`
  to finish. An SSE stream never finishes on its own, so after that the step closes what is left.
- **`nodeServerStep`** does the same for a `node:http` server, such as the one Express's
  `app.listen()` returns. On Bun 1.4.2 it cannot cut a request that is still running:
  `closeAllConnections()` leaves it open until its handler finishes. So the step waits `graceMs`
  once more, then moves on, and that request ends with the process.
- **`installProcessHandlers`** drains on SIGTERM, on SIGINT (what pm2 sends) and on an uncaught
  exception, and logs every crash through your logger. A second signal exits 1 at once, unless it
  comes within a second of the first: pm2 signals every process in the tree, and `bun run` forwards
  SIGINT and SIGTERM to the app as well, so one stop can arrive twice.
- **`rejections` is required.** `"survive"` logs a rejected promise nobody handled and keeps
  going, for an API whose requests share nothing. `"exit"` logs it and drains, for a worker, where
  a job that stopped halfway may have left bad state.

Each of these numbers must be larger than the one before it:

1. The longest request you let finish, or in a worker the longest job.
2. `hardExitMs`. On Bun 1.3.8, `bunServerStep` can take `graceMs` twice while a stream is open.
   A step that waits on its own counts too: pg-boss's `stop()` waits 30 seconds unless you pass
   `timeout`, which outlasted one API's 25-second `hardExitMs`.
3. Your process manager's kill timeout. pm2's `kill_timeout` is 1.6 seconds unless you set it.
4. When pm2 runs under systemd, the unit's `TimeoutStopSec`.

Check the order in a test that reads the numbers from your config files. One API had a 25-second
`hardExitMs` under a 70-second kill timeout, raised for requests that run up to 60 seconds, so
every deploy cut those requests off at 25.

**End open streams first.** An SSE stream or a long poll never finishes on its own, so while one is
open the server step waits out all of `graceMs`. When pm2 restarts one process at a time, nothing
answers new requests during that wait. Make the first step end them:

```ts
const draining = new AbortController();

// In each stream handler:
draining.signal.addEventListener("abort", () => stream.close(), { once: true });

shutdown = createShutdown(
  [
    { name: "streams", run: () => draining.abort() },
    bunServerStep(server, { graceMs: 5_000 }),
    // …
  ],
  { hardExitMs: 25_000, logger },
);
```

The client reconnects to the new process, and a request that has to finish still gets `graceMs`.
The steps run in order, so the first one runs the moment the drain starts; a job that should stop
early can watch the same signal.

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
- A webhook checked while no secret is set is refused, never passed.
- A secret still set to its `.env.example` placeholder stops the boot.
- A drain that hangs exits 1, never 0.
- A cron schedule without a time zone does not compile.
- A mail without a text part is refused.
- A mail login is never sent over a connection without TLS.
- An MCP tool handler never throws, and a tool's `.shape` does not compile.
- An API reference names the origin you configure, never the one a request came in on. A
  repeated operation id, a tag you did not list, or a schema that refers to itself throws.
- A webhook delivery never retries a 4xx or a redirect, and never comes back sooner than
  `Retry-After` asks, up to an hour.
- An idempotency key reused for a different request is refused, never replayed, and a failed save
  never fails a write that happened.

## Develop

```bash
bun install
cd server && bun run test
```

The Redis and Postgres tests start their own throwaway server, so they need `redis-server` and
`initdb` installed. Without them, those tests are skipped and marked as skipped.
