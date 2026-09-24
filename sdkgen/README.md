# @gusnips/sdkgen

The parts of a script that writes a TypeScript SDK for your API. You keep the script, because the
methods it writes are yours. This package holds the parts that are easy to get wrong.

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

## Why it exists

Five APIs each wrote their own SDK generator, about 2,500 lines in all. They were not copies. Each
had fixed something the others had not, and every one still had these bugs:

- A backslash at the end of a `//` comment hid the next line, so the declaration under it was never
  found.
- A string with a backslash before its line break moved every later line by one, so the generator
  copied the wrong text for every declaration after it in the file.
- `export interface Empty {}` on one line swallowed the declaration after it.
- A comment written `/*/` ended on the character that opened it.

This package is the merge, with each fix pinned by a test. Two of those generators were rewritten
on it and wrote every file byte for byte as before, 268 and 281 lines shorter.

MIT
