Entry point for AI agents working on this repo.

# serverkit

**The layer under a Bun or Node server on Postgres.** One package today: `@gusnips/migrate`, which
applies plain `.sql` files, writes TypeScript types from the live schema, and gives a stock Postgres
in CI the roles and `auth` tables a Supabase database starts with.

MIT · open source · npm scope `@gusnips`

## Why it exists

Extracted from eleven private backends that had each written the same three things: a migration
runner (11 copies, 2,799 lines), a type generator (10 copies, 2,893 lines) and an SSL helper (10
copies). They were not copies of each other. Read against each other, they held 16 runner bugs,
and for most of them a sibling repo had already written the fix. The merge is worth more than the
dedup, the same as in frontkit.

The source repos are private and are not named here. **That covers every file, code comment, test
name and commit message, because this repo is public.** Say "a donor", "one runner" or "the second
chain".

## Layout

```
serverkit/
├── migrate/              ← @gusnips/migrate. One required peer: pg.
│   ├── src/
│   │   ├── runner.ts     ← runMigrations(): the whole run, returns a result, never exits
│   │   ├── cli.ts        ← migrateCli(): flags → runMigrations, returns an exit code
│   │   ├── files.ts      ← reads the folder; directives.ts and split.ts parse each file
│   │   ├── target.ts     ← the remote-database guard, also exported for seed scripts
│   │   ├── lines.ts      ← the lines deploy workflows grep. Changing one breaks a workflow.
│   │   ├── db-types.ts   ← the generator; db-types-cli.ts is its command
│   │   ├── stand-in.ts   ← applies sql/supabase-stand-in.sql to a local database
│   │   ├── bin/          ← three two-line bins
│   │   └── test/         ← the throwaway-database helpers the tests share
│   └── sql/              ← supabase-stand-in.sql, also exported for `psql -f`
├── scripts/
│   └── check-release.ts  ← packs each package and checks what the registry would get
└── AGENTS.md             ← this file
```

Runner, CLI and bin are three layers on purpose. `runMigrations` is testable without a process,
`migrateCli` is what an adopter's five-line script calls, and the bin is what CI calls.

## Commands

```bash
bun install

TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/postgres bun run check
                             # format → build → lint → typecheck → test
bun run release:check        # what the REGISTRY would get: pack, unpack, run under plain node
bun run format
```

The tests are integration tests against a real Postgres. Each creates its own database and drops it
after. `TEST_DATABASE_URL` must be on this machine; `test/db.ts` refuses anything else, because the
tests create roles, drop databases and end sessions. Roles belong to the whole cluster, so
`test/global-setup.ts` creates them once before the files run in parallel.

Tests do not run in CI (the fleet's CI minutes policy). Run them before every commit that touches
`src/`. `prepublishOnly` runs them too, so publishing needs `TEST_DATABASE_URL` set.

## Naming and publishing

- **Scope `@gusnips`**, the same as frontkit. `publishConfig.access` is `public` so a release cannot
  go private by default.
- **Release with `bun publish`, never `npm publish`**, and **delete `bun.lock` and reinstall after a
  version bump.** Both rules came from frontkit, where each one shipped a broken tarball. Neither
  bites with one package, and both will the day a second package depends on this one.
  `release:check` already checks both.
- **Adopters resolve from the registry**, never `link:` or `file:`.
- **Nothing is published or pushed without Gus.** The GitHub repo does not exist yet.

## Invariants — do not regress these

Each one is a bug a donor shipped, or a fix a donor had and the others did not. The tests pin them.
When one fails, a lesson is being unlearned.

1. **Ask before taking the lock, never while holding it.** A runner prompted `[y/N]` while it held
   `pg_advisory_lock`. An operator who walked away blocked the next deploy's runner with no end, and
   no runner set a timeout. The runner also refuses to ask without a terminal: under Bun, `prompt()`
   blocks while stdin stays open, which is what `ssh host 'migrate --manual'` gives it.
2. **The lock comes before any DDL, and the wait for it is bounded.** Six runners created the
   tracking table before locking, and two runners creating it at once on an empty database can fail
   on the catalog's unique index. The wait is `lock_timeout` on `pg_advisory_lock` (measured: it
   applies), 120 seconds by default, and the message names the session that holds it.
3. **`RESET ALL` before every file.** A `pg_dump` baseline runs
   `set_config('search_path', '', false)`, which lasts for the session, so in three donors every file
   after the baseline failed at its first unqualified name, on any replay from empty. The same dump
   leaves `check_function_bodies = false` on. Measured: `RESET ALL` keeps the advisory lock, and
   restores the `-c search_path` the connection started with.
4. **A no-transaction file is split into statements.** Postgres runs a multi-statement query as one
   implicit transaction, and `CREATE INDEX CONCURRENTLY` refuses to run inside one (measured). Six
   runners sent the whole file at once, on the path one of them documented as the way to run
   `CONCURRENTLY`. The splitter refuses `BEGIN ATOMIC` rather than cut a function body in half.
5. **Directives come from the leading comment block only, and an unknown one is an error.** The old
   marker `-- @manual` meant "gated, in a transaction" in four runners and "no transaction" in six,
   so reading it either way changes one family's files without a word. It is an error now, and so is
   a directive after the first statement, because that is a directive somebody thinks is working.
6. **A held file is held, not a halt.** Later files still apply. A halt would turn every gated
   contract migration, which can wait weeks for a person, into a schema freeze. A later file that
   needs a held one fails loudly, in its own transaction. CI replays pass `--manual --yes`, because a
   replay that skipped a held file is exactly how one donor's chain broke.
7. **"Nothing to do" is printed only when nothing is held.** Six runners printed it right under a
   held file. Four more printed it after cancelling the question, and exited 0 with no held-file
   line at all.
8. **The guard counts only what this run would apply.** Two runners counted held files, so a laptop
   run with only a gated file pending refused with "Refusing to apply 1 migration(s)" for a run that
   would apply nothing.
9. **Unknown flags are an error, and nothing runs.** All eleven ignored them, so in the eight with
   no `--status`, `migrate --status` applied every pending file.
10. **`--status` is read-only: no DDL, no lock.** One runner created the schema and table before
    its status branch, so a status check wrote to a fresh database. And a status that cannot reach
    the database exits 1 and prints no `Status:` line. One deploy ended its status command with
    `|| true`, so a dead database printed nothing and read as "up to date".
11. **The runner listens for `error` on the client.** None of the eleven did. When the connection
    drops, pg emits `error` right after it rejects the query, and with no listener that throws, so the
    process died before it could name the file it was applying.
12. **The lines a workflow greps are constants in `lines.ts`, pinned byte for byte.** A chain
    verifier required `Applying 000_baseline.sql (1 of 1)` and failed on every run once the folder
    held six files. And `${LINE#*[MIGRATIONS] }` is a trap in three workflows: in a shell pattern the
    brackets are a set that matches ONE character. It happens to cut the right text on the
    `MANUAL_PENDING` line, which is luck, so the README shows `${LINE#*MANUAL_PENDING }`.
13. **The package runs under plain Node.** No `import.meta.dir`, no `Bun.*`, no `prompt()`. The bin
    test runs under `node`, and `release:check` imports the packed tarball under `node`.
14. **The runner script imports nothing from the app.** One donor's runner imported the app's
    barrel, which loaded an AI client, which threw when its API key was unset, so a schema change
    failed for want of an unrelated key. An adopter's script imports `@gusnips/migrate` and nothing
    else. A seed script that needs the guard imports it from the package, not from the runner
    script, because the runner script runs on import.
15. **Types regenerate only after a run that applied something, and only after the client has
    closed.** One donor's wrapper regenerated types after `--status` too.

### …and four for `db-types`

16. **The output has no timestamp.** The same schema gives the same bytes, which is the only way
    `--check` can compare. `--check` compares after `--format`, because the committed file is the
    formatted one.
17. **A foreign key into another schema is left out of `Relationships`.** The `Database` type
    describes one schema, so the donor generators emitted `REFERENCES auth.users` as a relationship
    to the schema's own `users` table, and a join PostgREST refuses typechecked.
18. **Generated columns and identity `GENERATED ALWAYS` columns are `?: never` in `Insert` and
    `Update`.** Postgres refuses a value for them, so `?: T` typechecked an insert that failed at
    runtime.
19. **`money` and `halfvec` map to `string`.** `money`'s text form is `$1.00`, which is not a JSON
    number.

### The SSL helper

`pgSsl(url)` keeps what ten donor copies did: an `sslmode` in the URL wins, Supabase cloud hosts
connect without a certificate check, and every other host connects without TLS. Whether Supabase
cloud certificates verify with Node's default CA store has not been measured. Until it is,
`sslmode=verify-full` in the URL is how an adopter asks for a check.

## What the build measured

- **Every donor chain replayed from an empty Postgres 18.** Eleven chains, 313 files, each run as
  stand-in → `migrate --manual --yes` → a second run that applies nothing → `--status`. Eight
  applied as they are. One needed `pgvector` on the server. One needed `pgvector` and a guard around
  an extension it creates and never uses. One stopped before connecting, on purpose, at its one file
  with the old `-- @manual` marker, and applied in full once that marker was renamed. Four chains
  ran with `--search-path app`, because their files name tables without a schema.
- **The generator was proved against the old ones on the same databases.** Four came out
  byte-identical after the header. One differed only in a comment's wording. The other five differ
  by design (relationships, write shapes, helper names), and each was checked with a predicate that
  every `Row` type is unchanged, rather than read by eye.
- **Every test for a donor bug was watched failing first**, by putting the bug back into the runner
  and running the suite.

## House rules

- 2-space, printWidth 100, double quotes.
- Source imports keep real `.ts` extensions; `rewriteRelativeImportExtensions` emits `.js`.
- No `as any` / `as unknown as T`. Fix the type.
- Comments explain **why**, and name the production reason. A rule without its reason gets
  simplified away.
- Errors say what failed, the likely cause, and what to do next.
- The tree may be shared. Stage by pathspec and check `git diff --cached --name-only` before every
  commit.
