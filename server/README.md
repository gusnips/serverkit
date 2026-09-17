# @gusnips/server

One error shape, one response envelope, and one function that turns a thrown thing into an HTTP
answer. No framework at the root: it runs in a Cloudflare Worker, in a Bun or Node server, in a
queue consumer, and in an MCP tool handler.

```bash
bun add @gusnips/server
```

```ts
import { ok } from "@gusnips/server";

ok({ id: 1 });
// → { status: 200, body: { data: { id: 1 } } }
```

Every 2xx body is `{ data }`. Every refusal is `{ error: { code, message, messageKey?, params?,
details? } }`. That is the envelope `@gusnips/http` declares and a browser client parses, so the
two ends of one request never disagree about the shape.

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

The map has to be `as const`, or every value reads as `number` and the rule below cannot see a 429. A map without it is refused, with the instruction in the compiler's message.

### A 429 states its own wait

`RATE_LIMIT_EXCEEDED` maps to 429, so `retryAfterSecs` is a **required argument**. Leave it out
and the code does not compile.

This is the rule with the best bug-per-line ratio in the whole extraction. One backend writes a
`resetAt` ISO date that no HTTP client parses, and then keeps a hand-written list of "codes that
do not clear by waiting" in its browser app to compensate — its own comment says that is why the
list exists. Another backend needs no list, because every 429 it sends states its wait. A third
raises a spent daily cap with no wait at all, on a code its client reads as transient, so the
browser retries a limit that clears at midnight — twice, immediately, and says the same thing
three times to a limiter that is already counting.

A stated wait answers the question those lists were guessing at. `errorResponse` renders it as
the standard `Retry-After` header **and** folds it into `details`, so an HTTP client, a proxy and
your own SDK all learn the same wait from one value.

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
