# serverkit

Packages for the server side of a Bun or Node app on Postgres.

```bash
bun add @gusnips/migrate pg
```

```bash
DATABASE_URL=postgresql://postgres@localhost:5432/app bunx gusnips-migrate --dir migrations
```

That applies every `.sql` file in `migrations/` that has not run yet, in order, each in its own
transaction.

| Package                                 | What it is                                                    | Needs      |
| --------------------------------------- | ------------------------------------------------------------- | ---------- |
| [`@gusnips/migrate`](migrate/README.md) | a SQL migration runner, a type generator, a Supabase stand-in | `pg`       |
| [`@gusnips/server`](server/README.md)   | errors, the response envelope, logging, and the API's edge    | nothing    |
| [`@gusnips/sdkgen`](sdkgen/README.md)   | the parts of a script that writes your API's TypeScript SDK   | `prettier` |

## Why it exists

Eleven apps each wrote their own migration runner, and ten wrote their own type generator: about
5,700 lines in all. They were not copies. Each one had fixed something the others had not, and
each one still had a bug another had already fixed. A few of them:

- A runner asked "apply this? [y/N]" while holding its lock. Nobody answered, and the next deploy
  waited on that lock with no end.
- In eight runners, `migrate --status` ignored the flag it did not know and applied every pending
  file.
- A database dump sets `search_path` to empty and leaves it that way for the session, so replaying
  from an empty database failed at the first file after it.
- A status check that could not reach the database printed nothing, and the workflow read nothing
  as "up to date".

This package is the merge, with each of those pinned by a test.

## Develop

```bash
bun install
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres bun run check
bun run release:check
```

The tests need a Postgres on this machine that they may create and drop databases in. They refuse
any other host.

MIT
