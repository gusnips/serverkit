# @gusnips/server

One error shape, one response envelope, one allow-list logger, and one function that turns a
thrown thing into an HTTP answer. No framework at the root: it runs in a Cloudflare Worker, in a
Bun or Node server, in a queue consumer, and in an MCP tool handler.

```bash
bun add @gusnips/server @gusnips/http
```

`@gusnips/http` is a required peer: it declares the envelope, and your API and your browser
client both import it, so there is one declaration of the wire contract and not two.

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

`AppError` has no `toJSON()`, and that is load-bearing rather than an omission. `JSON.stringify`
calls a value's own `toJSON()` **before** it calls the replacer, so a class that defines one
never reaches a logger's `Error` branch: `logger.error("failed", { error: err })` writes
`{"error":{"error":{code,message}}}` with no stack and no cause. Seven backends define one and
all seven log exactly that. The wire body comes from `errorResponse`, where the mask lives
anyway, and the error stays an error.

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
package's dependency. Measured against zod 3.25, 4.4 and 4.5.

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

## Writing logs

`createLogger` writes one JSON object per line. Call it once, then pass the logger to the code that
needs it.

```ts
import { createLogger } from "@gusnips/server";

const logger = createLogger();
logger.info("server started");
// → { "level": "info", "time": "…", "message": "server started" }
```

It has `debug`, `info`, `warn` and `error` methods. The default threshold is `info`; pass the
setting your runtime owns when it should differ:

```ts
const logger = createLogger({ level: process.env.LOG_LEVEL });
```

An unknown level throws at boot instead of quietly changing what the box records. Use `silent` to
write nothing. Pass `write(line, level)` when a process manager is not the only destination; it is
a seam for your exporter, not a transport built into this package.

Pass the raw error, never `String(error)`:

```ts
try {
  await charge(order);
} catch (error) {
  logger.error("charge failed", { orderId: order.id, error });
}
```

The serializer writes an error's `name`, `message`, `stack` and `cause`, plus only the extra fields
in `keptErrorFields`. A plain-object cause goes through the same list. Circular values do not break
the log call, and a Postgres `DETAIL` containing the whole failed row is replaced rather than
written. The allow-list covers errors, not arbitrary metadata: never put a password, token or raw
request body in the metadata object.

## Using Hono

The root package does not load Hono. Install Hono and import the adapter only in an app that uses
it:

```bash
bun add hono @gusnips/server @gusnips/http
```

Put `RequestVariables<ErrorCode>` in the app's `Variables`, mount the request logger first, then the
boundary:

```ts
import { createLogger } from "@gusnips/server";
import {
  errorBoundary,
  errorHandler,
  notFoundHandler,
  requestLogger,
  type RequestVariables,
} from "@gusnips/server/hono";
import { Hono } from "hono";
import { errorResponse, errors, type ErrorCode } from "./errors.ts";

type AppEnv = {
  Bindings: { API_ORIGIN: string };
  Variables: RequestVariables<ErrorCode>;
};

const app = new Hono<AppEnv>();
const logger = createLogger();

app.use(requestLogger({ logger }));
app.use(errorBoundary);

app.onError(errorHandler({ errorResponse, logger }));
app.notFound(notFoundHandler(errorResponse(errors.notFound("Route"))));
```

Pass `errorHandler(...)` and `notFoundHandler(...)` straight to Hono as shown. That call gives
TypeScript the app's full environment, including its `Bindings`; storing a handler first throws
that context away and can widen its types.

The boundary turns a thrown value that is not an `Error` into one and keeps the original as its
`cause`. Without it, Hono does not call `onError` for that value. The error handler writes 5xx and
unexpected failures with their raw error. A routine 4xx writes no second line: its code goes on the
request line. Pass `onUnexpected` to `errorHandler` when that last branch should alert someone. The
callback runs inside Hono's error path, so it must not throw; hand slow work off instead of waiting
for it.

### Request logs and IDs

Each completed request line has `requestId`, `method`, `route`, `status`, `ms` and, on a refusal,
`errorCode`. `route` is the matched template, such as `/people/:id`, never the caller's path. If a
dashboard or alert reads a `path` field from an older request logger, move it to `route` when you
adopt this one.

A valid incoming `X-Request-ID` is kept; anything longer than 64 characters or outside
`A-Z a-z 0-9 . _ -` is replaced. Every response returns the final id. A browser may read it across
origins only when CORS exposes it:

```ts
import { cors } from "hono/cors";

app.use("*", cors({ exposeHeaders: ["X-Request-ID"] }));
```

`OPTIONS`, `/health` and everything below `/health` are quiet by default. A throw is still logged.
Use `skipPaths` only for other routine endpoints.

### Route guards

Wrap a guard where it is defined, then mount that same function before the routes it protects:

```ts
import { guard } from "@gusnips/server/hono";
import { requireAdminMiddleware } from "./auth.ts";

export const requireAdmin = guard(requireAdminMiddleware);

app.use("/admin/*", requireAdmin);
```

In one test of the fully built app, ask Hono's own matcher whether a guard runs before every private
endpoint:

```ts
import { assertEveryRouteGuarded } from "@gusnips/server/hono";
import { app } from "./app.ts";
import { isPublic } from "./public-routes.ts";

assertEveryRouteGuarded(app, { isPublic });
```

Pass the predicate the app itself uses. Do not make a second exemption list only for this test. If
the app's rule is already a list of prefixes, build the shared predicate with `underAny`:

```ts
import { underAny } from "@gusnips/server/hono";

export const isPublic = underAny(["/health", "/webhooks/*"]);
```

`/webhooks` and `/webhooks/*` both cover `/webhooks` and `/webhooks/provider`, but not
`/webhooks-old`. The check uses Hono's real matcher and registration order, so it catches a guard
mounted after its route. It also refuses an app with no endpoints and a guard that runs in front of
nothing; both often mean a test mounted a stand-in router instead of the real one.

### Keep one Hono copy

The app and `@gusnips/server/hono` must resolve the same Hono runtime copy. Hono stores route-match
state under a symbol local to its copy, so a second copy cannot read the first one's match. If route
logging fails after installation, check the tree:

```bash
bun pm ls hono
```

Use one Hono version that satisfies the package's peer range. A nested second copy is an install
fault, not a request-logger failure.

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
- **A styled error page, a logger transport, or an alerting client.** `errorResponse` returns
  `kind` so you can route those yourself.

## Rules it will not let you break

- A 429 raised with no wait does not compile.
- A code→status map that is not `as const` is refused.
- A code outside your map, or a message key outside your union, does not compile.

## Develop

```bash
bun install
cd server && bun run test
```
