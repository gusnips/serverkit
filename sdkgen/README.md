# @gusnips/sdkgen

The parts of a script that writes a TypeScript SDK for your API. You keep the script: it picks the
names, the doc text and anything written by hand. This package writes the rest, including the
parts that are easy to get wrong.

```bash
bun add -d @gusnips/sdkgen prettier
```

```ts
import { typeOf } from "@gusnips/sdkgen";

typeOf({ type: ["string", "null"] });
// → "string | null"
```

`typeOf` turns a JSON Schema into the TypeScript type it describes. A zod schema works too, through
`inputJsonSchema`, and each field keeps its description as a doc comment:

```ts
import { z } from "zod";
import { fieldsOf, inputJsonSchema } from "@gusnips/sdkgen";

fieldsOf(inputJsonSchema(z.object({ to: z.string().describe("Who gets it.") })));
// → "    /** Who gets it. */\n    to: string;\n"
```

## What is in it

| Function                  | What it does                                                                       |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `liftContract`            | Copies the types your API answers with into one file, comments included.           |
| `typeOf`                  | Writes a JSON Schema as a TypeScript type.                                         |
| `fieldsOf`                | Writes an object schema's fields, one per line, each description as a doc comment. |
| `paramsInterface`         | Writes `export interface SendParams { … }`, and says if every field is optional.   |
| `docComment`              | Writes `/** … */`, wrapped at 96 columns.                                          |
| `wrapLines`               | Breaks prose into lines for a comment you lay out yourself.                        |
| `typeNames`               | Lists the type names in an expression: `Page<Job>[]` gives `Page` and `Job`.       |
| `camelCase`, `pascalCase` | `send_message` gives `sendMessage` and `SendMessage`.                              |
| `inputJsonSchema`         | Turns a zod schema into JSON Schema. JSON Schema passes through as it is.          |
| `writeGenerated`          | Formats and writes the files, or lists the ones that are out of date.              |
| `sdkMethods`              | Writes one SDK method per operation, and the params type each one takes.           |
| `transportSource`         | Returns the code every method runs on: the request, the retries, the error.        |
| `retrySource`             | Returns the rule for when a failed call is worth another try.                      |

## Copy your API's types

An SDK is published on its own, so it cannot import your API's code. The types it returns have to
be copied into it.

```ts
import { liftContract } from "@gusnips/sdkgen";

const contract = liftContract({
  root: repoRoot,
  sources: ["packages/shared/src/http.ts", "packages/shared/src/dto.ts"],
  roots: ["ApiError", "MessageDto"],
});
```

That returns one file's text. It has each name in `roots` with its doc comment, then every type
those mention, in the order they appear in `sources`. If a name is declared nowhere, it stops and
lists the files it searched.

Two options change what comes out:

- `inlineTuples: true` writes `(typeof STATUSES)[number]` as `"queued" | "sent" | "failed"` and
  leaves the array out. Use it when the SDK has no use for the array. It is off by default, because
  an SDK that re-exports its contract publishes that array, and each member's doc comment goes with
  it.
- `exportOnlyRoots: true` keeps `export` on the names in `roots` only. The types they mention are
  still written, so the file compiles, but they are not part of the SDK's public names.

It reads your files as text, not with the TypeScript compiler, because the compiler's `.d.ts`
output drops the comments. It finds `export interface`, `export type`, `export const` and
`export function` at the start of a line. Two limits:

- A name of one or two letters, like `T` or `K`, is taken to be a type parameter and not followed.
  If a real type has a name that short, the SDK will not compile, so you find out.
- A quote inside a regex literal, like `/"/`, is read as the start of a string.

## Write the methods

Give each operation an `sdk` field that says what its method is called and what it returns. An
operation without one gets no method.

```ts
import { sdkMethods } from "@gusnips/sdkgen";

const { members } = sdkMethods([
  {
    name: "health",
    method: "get",
    path: "/health",
    summary: "Check the API is up.",
    sdk: { method: "health", returns: "HealthDto" },
  },
]);
```

`members` is the method as text, ready to go inside a class:

```ts
    /**
     * Check the API is up.
     */
    health(opts?: Omit<RequestOptions, "idempotencyKey">): Promise<HealthDto> {
        return this.request({ method: "GET", path: "/health" }, undefined, opts);
    }
```

The operations are the same list you hand `buildOpenApi` from `@gusnips/server`, so you write them
once. `sdk.method` is a name like `sendMessage`, or `numbers.pair` to put the method in a `numbers`
group. `sdk.returns` is the type `data` holds: `MessageDto`, `NumberDto[]`, or `void` for a 204.
From `@gusnips/server` 0.8.24, `buildOpenApi` checks the `sdk` field and writes it into the
reference as `x-sdk`.

Each method calls `this.request(spec, params, opts)`. Your class declares it and sends the call
through the transport, below. `sdkMethods` also returns:

- `params`: an `export interface …Params` for each method that takes arguments, written from the
  operation's `input` schema. A path slot is filled from the field of its name, or the one
  `params` maps to it.
- `paramTypes` and `returnTypes`: the names your file has to import.
- `routes`: where each generated method sends its call, keyed by the method. Here that is
  `{ health: { method: "GET", path: "/health", pathParams: [] } }`. A slot in `path` carries the
  argument's name, and `pathParams` lists those arguments in path order. Use it for a docs page
  that shows a REST call beside the SDK call that makes it.

Four options:

- `namespaces`: the groups, in the order the client lists them. A group missing from the list is an
  error, so a typo cannot start a new one.
- `doc(op)`: the method's doc comment, one string per paragraph. Default: the summary, then the
  description.
- `specExtra(op)`: more fields on the spec, for your own `request` to read.
- `inject`: methods you write by hand, such as one that polls a job. They go beside the generated
  ones and must not take one of their names.

It stops with an error that names the operation when a method name has more than one dot, two
methods want one name, a status with no body (204, 205, 304) returns something, or a path slot is
filled by a field the caller may leave out.

## Send the calls

Two more files go into the SDK. `transportSource()` is the code that sends each call: it fills the
path, tries again when that is safe, and turns a failure into your SDK's own error.
`retrySource()` is the rule it asks, from `@gusnips/http`. Both are plain TypeScript that import
nothing else, so the SDK installs nothing.

```ts
import { retrySource, transportSource } from "@gusnips/sdkgen";

const files = {
  "packages/sdk/src/generated/retry.ts": retrySource(),
  "packages/sdk/src/generated/transport.ts": transportSource(),
};
```

Your client hands its settings to `send`, which returns `{ data, meta }`:

```ts
import { GeneratedOperations } from "./generated/operations.ts";
import {
  send,
  type RequestOptions,
  type RequestSpec,
  type Transport,
} from "./generated/transport.ts";

export class Example extends GeneratedOperations {
  private readonly transport: Transport;

  constructor(apiKey: string) {
    super();
    this.transport = {
      baseUrl: "https://api.example.com/v1",
      headers: { authorization: `Bearer ${apiKey}` },
      error: (failure) => new ExampleError(failure),
    };
  }

  protected async request<T>(spec: RequestSpec, params?: object, opts?: RequestOptions) {
    return (await send<T>(this.transport, spec, params, opts)).data;
  }
}
```

| Setting                   | Default   | What it does                                                                |
| ------------------------- | --------- | --------------------------------------------------------------------------- |
| `baseUrl`                 | required  | Where the API lives, with its base path.                                    |
| `error(failure)`          | required  | Builds your SDK's error. The transport throws what it returns.              |
| `headers`                 | none      | Sent on every call.                                                         |
| `fetch`                   | global    | `(url, init) => Promise<Response>`, such as a fake one in tests.            |
| `timeoutMs(spec, params)` | 30,000 ms | How long one try waits for an answer. A call's `opts.timeoutMs` wins.       |
| `maxRetries`              | 2         | Extra tries after a failure worth repeating.                                |
| `durableCodes`            | none      | Error codes that waiting does not fix, such as a spent monthly quota.       |
| `mintKeys`                | false     | Makes up an idempotency key for a call that takes one, so it can try again. |

`failure` has the status (0 when no answer came back), the API's `error`, the `Retry-After` wait,
the request id, and the idempotency key the call went out with. A call that may have run can be
sent again with that key, and the API answers from the first run.

A failed call is tried again:

- **After a 408, 425 or 429**, whatever it is. Those say the API did not run it.
- **After no answer, a 5xx, or a 409 that says when to come back**, only if running it twice is
  safe. A GET is. A write is when its operation reads an `Idempotency-Key` and the call has one, or
  when its `sdk.repeatable` is true. A write without a key is not sent twice, because it may
  already have run.
- **Never** when the answer says waiting will not help: a code in `durableCodes`,
  `details.retryAfterSecs: null`, or a wait longer than 10 seconds.

It waits what the `Retry-After` header says, in seconds or as a date, then what
`details.retryAfterSecs` says. With neither, it waits about 1 second, then 2.

Every method's last argument takes `timeoutMs` for that one call, and `signal` to stop it. A call
that reads an `Idempotency-Key` also takes `idempotencyKey`. A call stopped by its `signal` throws
the signal's reason rather than your SDK's error, because nothing failed, and it is not tried
again, even partway through a wait. `signal` needs `AbortSignal.any`, which Node has from 18.17 and 20.3.

## Keep the SDK current

```ts
import { writeGenerated } from "@gusnips/sdkgen";

const files = { "packages/sdk/src/generated/contract.ts": contract };
const { stale } = await writeGenerated(files, {
  root: repoRoot,
  check: process.argv.includes("--check"),
});
if (stale.length > 0) {
  console.error(`Out of date:\n  ${stale.join("\n  ")}\nRun \`bun run sdk:gen\` and commit.`);
  process.exitCode = 1;
}
```

`files` maps each path to its text. A relative path starts from `root`, and `stale` and `written`
list paths the way `files` spells them. Each file is formatted with the prettier config for its
path before it is compared or written, so `prettier --check` and `--check` always agree. With
`check`, nothing is written. A file it cannot read, for a reason other than not existing, is an
error and not "out of date".

## Rules

- **It never guesses a type.** A schema it does not understand, such as `allOf` or a `$ref`, throws
  with the schema in the message. A wrong `unknown` in a published SDK hides the mistake from
  everyone who installs it. It writes `unknown` only where the schema itself allows any value,
  as `{}` does.
- **A field name that is not an identifier is quoted:** `"content-type"?: string`.
- **A `*/` in a description is broken up**, so it cannot end the doc comment early.
- **A zod schema needs zod 4.4 or later.** Older versions cannot describe themselves as JSON
  Schema, and the error says so.
- **A call with a missing path value throws a TypeError** before anything is sent, rather than
  calling `/numbers//pair`.
- **An idempotency key on a call that takes none throws.** The API would ignore it, so it could not
  stop the call running twice. The method's type refuses it first: only a call that takes a key
  accepts `idempotencyKey` in its options.

## Why it exists

Five APIs each wrote their own SDK generator, about 2,500 lines in all. They were not copies. Each
had fixed something the others had not, and every one still had these bugs:

- A backslash at the end of a `//` comment hid the next line, so the declaration under it was never
  found.
- A string with a backslash before its line break moved every later line by one, so the generator
  copied the wrong text for every declaration after it in the file.
- `export interface Empty {}` on one line swallowed the declaration after it.
- A comment written `/*/` ended on the character that opened it.

This package is the merge, with each fix pinned by a test. All five generators were then rewritten
on it and wrote every file byte for byte as before, each 267 to 281 lines shorter.

MIT
