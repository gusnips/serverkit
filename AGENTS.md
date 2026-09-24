Entry point for AI agents working on this repo.

# serverkit

**The layer under a Bun or Node server on Postgres.** Two packages:

- **`@gusnips/migrate`** applies plain `.sql` files, writes TypeScript types from the live schema,
  and gives a stock Postgres in CI the roles and `auth` tables a Supabase database starts with.
- **`@gusnips/server`** is the answer edge: the error class, the wire envelope and its mask, the
  JSON logger, a `/hono` subpath with the middleware and the four success adapters, and a
  `/supabase` subpath holding the one decision a backend makes about Supabase Auth's answers, a
  `/pg` subpath holding the two a backend makes when it creates a connection pool, a `/redis`
  subpath holding the connection every backend on this stack opens for BullMQ and the bounded
  probes that make it safe to read from, and a `/node` subpath for what only a Node or Bun process
  can do: `fetchPublic`, the SSRF-safe fetch that resolves a customer's URL once and sends to the
  address it checked. The half of that guard a Worker can run is at the root. **No required peer.** `@gusnips/http` is used for its
  types and nothing else, so it erases and is optional; `hono`, `@supabase/supabase-js`, `pg` and
  `ioredis` are optional and reachable only behind their subpaths.

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
│   │   ├── bin/          ← one bin, gusnips-migrate, which dispatches its two commands
│   │   └── test/         ← the throwaway-database helpers the tests share
│   └── sql/              ← supabase-stand-in.sql, also exported for `psql -f`
├── server/               ← @gusnips/server. Each optional peer sits behind its own subpath.
│   └── src/
│       ├── errors.ts     ← AppError and createAppError(): your code→status map is the contract
│       ├── responses.ts  ← the envelope both ways: ok/created/paginated, and createErrorResponse
│       ├── logger/       ← createLogger() and the serializer that decides what a log line keeps
│       ├── hono/         ← the edge: errorBoundary, guards, headers, CORS and the four adapters
│       ├── supabase/     ← isAuthOutage(): did auth say no, or fail to answer?
│       ├── pg/           ← createPgPool(): the wait is bounded, the idle handler is required
│       ├── redis/        ← createRedis(), the bounded probes, and the rate-limit window store
│       ├── bullmq/       ← queues that delete finished jobs, the dead letter, the schedule sync
│       ├── mcp/          ← the MCP door: tools that never throw, a limit per call, POST only
│       ├── rate-limit.ts ← hitWindow() and the memory store; rateLimit() is in hono/
│       ├── client-ip.ts  ← clientIpOf() and ipSubject(): the socket first, a header only from the proxy
│       ├── ip.ts         ← the IPv4 and IPv6 parsers url-guard and client-ip share; not exported
│       ├── url-guard.ts  ← the SSRF check a Worker can run: address, URL shape, redirect, body cap
│       ├── crypto.ts     ← safeEqual() and hmacSha256(), on Web Crypto so a Worker runs them
│       ├── webhook.ts    ← sign and verify, in Stripe's one-header format and Standard Webhooks
│       ├── seal.ts       ← createSealer(): AES-GCM for a secret you store, with a key id to rotate
│       ├── token.ts      ← signToken() and verifyToken(): a link that proves who it is for
│       ├── unsubscribe.ts← listUnsubscribeHeaders(): both one-click headers, for any sender
│       ├── env.ts        ← validateEnv(): every problem with the environment, in one error
│       ├── node/         ← the one directory allowed Node: fetchPublic(), scryptSealKey() and the drain
│       │   └── mail/     ← createMailer(), the /mail subpath: SMTP needs a socket a Worker lacks
│       └── __tests__/    ← the throwaway redis-server the Redis and BullMQ suites share
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

`@gusnips/server` has no database and no server in its tests: they drive a real Hono app and read
the bytes back. `migrate`'s are integration tests against a real Postgres. Each creates its own
database and drops it after. `TEST_DATABASE_URL` must be on this machine; `test/db.ts` refuses anything else, because the
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
- **Nothing is published or pushed without Gus.**

## Invariants — do not regress these

Each one is a bug a donor shipped, or a fix a donor had and the others did not. The tests pin them.
When one fails, a lesson is being unlearned.

1. **Ask before taking the lock, never while holding it.** A runner prompted `[y/N]` while it held
   `pg_advisory_lock`. An operator who walked away blocked the next deploy's runner with no end, and
   no runner set a timeout. The runner also refuses to ask without a terminal: under Bun, `prompt()`
   blocks while stdin stays open, which is what `ssh host 'migrate --manual'` gives it.
2. **The lock comes before any DDL, and the wait for it is bounded.** Six runners created the
   tracking table before locking, and two runners creating it at once on an empty database can fail
   on the catalog's unique index. The wait is 120 seconds by default, and the message names the
   session that holds it. **The wait polls `pg_try_advisory_lock` once a second; it never blocks in
   `pg_advisory_lock`.** A session blocked in that call holds a snapshot for the whole wait. When the
   run holding the lock is building an index CONCURRENTLY in a no-transaction file, the build waits
   for every older snapshot to end, the waiter's included, and the waiter waits for the lock.
   Postgres reports `deadlock detected` after `deadlock_timeout` (1s), long before any
   `lock_timeout`, and kills one side; when that is the build, the index stays INVALID. Reproduced
   in two donor runners, with and without `lock_timeout`, and in this package's test before the fix.
   The key is one default, `727001001`, in every repo; most old runners used another key or none, so
   during the one deploy that swaps a repo's runner an old run and a new run may not exclude each
   other, and that repo's deploy concurrency group is what covers it.
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
   so reading it either way changes one family's files without a word. It is an error now on any
   line of the file, not only at the top: six runners matched it anywhere, so a file marked below its
   first statement was held, and it must not start applying without a word. A `-- migrate:`
   directive after the first statement is an error too, because somebody thinks it is working.
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
16. **One bin, and its name starts with `gusnips-`.** The first build shipped `migrate`, `db-types`
    and `supabase-stand-in`. The first two are unrelated packages on npm, and anyone can register
    the third, so the README's own `bunx migrate`, run in a CI job without this package installed,
    would download a stranger's code and run it with `DATABASE_URL` in its environment. Generic
    names also collide in an adopter's `node_modules/.bin`. `db-types` and `supabase-stand-in` are
    commands under `gusnips-migrate`, read from the first argument before any flag parsing, so an
    unknown flag or a command name anywhere else is still an error. `release:check` refuses a bin
    without the prefix.

### …and four for `db-types`

17. **The output has no timestamp.** The same schema gives the same bytes, which is the only way
    `--check` can compare. `--check` compares after `--format`, because the committed file is the
    formatted one.
18. **A foreign key into another schema is left out of `Relationships`.** The `Database` type
    describes one schema, so the donor generators emitted `REFERENCES auth.users` as a relationship
    to the schema's own `users` table, and a join PostgREST refuses typechecked.
19. **Generated columns and identity `GENERATED ALWAYS` columns are `?: never` in `Insert` and
    `Update`.** Postgres refuses a value for them, so `?: T` typechecked an insert that failed at
    runtime.
20. **`money` and `halfvec` map to `string`.** `money`'s text form is `$1.00`, which is not a JSON
    number.

### The SSL helper

`pgSsl(url)` keeps what ten donor copies did: an `sslmode` in the URL wins, Supabase cloud hosts
connect without a certificate check, and every other host connects without TLS. Whether Supabase
cloud certificates verify with Node's default CA store has not been measured. Until it is,
`sslmode=verify-full` in the URL is how an adopter asks for a check.

### A driver fact

`pg` cannot connect to a bracketed IPv6 URL: `postgresql://…@[::1]:5432/app` fails with `ENOTFOUND`,
because the brackets reach the DNS lookup, while `host: "::1"` connects. Measured with pg 8.23 under
both Bun 1.3.8 and Node 22. It is the driver's, not the runner's, and `describeTarget` stripping the
brackets is still right for the guard. Someone on IPv6 loopback writes `localhost` or passes the
host outside the URL.

### …and twenty-five for `@gusnips/server`

21. **A success builder returns an ANSWER, not a body — so on Hono, import the adapters.** `ok`,
    `created`, `paginated` and `noContent` in `responses.ts` answer `{ status, body }`, because the
    layer is framework-free and owes its caller a status. Three of three Hono adopters therefore
    wrote the same four unwrapping lines by hand, and one wrote `c.json(ok(data))` instead of
    `c.json(ok(data).body)`: every 200 from a live API answered `{"status":200,"body":{"data":…}}`
    for fifty minutes. **Nothing caught it and nothing could** — `c.json` takes any JSON value so
    the types held, the status stayed 200 so every probe and the deploy gate held, and a test that
    calls the builder never sees the body its caller sends. A client found it, because a client is
    the only reader that parses the envelope. `@gusnips/server/hono` ships the four adapters, so
    the wrong line is not available to write. `noContent` is the half a hand-written adapter gets
    wrong quietly: `c.body(null, 204)`, where `c.json(null, 204)` writes the four bytes `null` and
    a `content-type` under a status that promises neither.

    **And the adapters shipped not delivering that sentence, which is the half worth keeping.** The
    first version was `ok(c, data, status)` over a builder that takes `ok(data, meta?)` — a wrapper
    that NARROWED what it wrapped. The fifth adopter is a metered API whose every read answers
    `{ data, meta }` with what the call cost, and with no slot for it, that repo's `/v1` layer had
    written its own `ok` building the envelope by hand: the exact line this invariant claims is
    unavailable, produced BY the adapter's existence rather than in spite of it. Fixed in 0.2.1
    (`ok<T, M>(c, data, status, meta?)`, generic in the meta like the builder — a page's is
    `PaginationMeta`, a product's is whatever that product measures, and the package does not get
    to name it). The general rule underneath: **a wrapper you have to step around for the common
    case protects nobody**, so an adapter that drops an argument its own builder takes is a bug in
    the adapter, not a smaller API. Check a wrapper against the signature it wraps, not against how
    tidy it reads.

22. **`AppError` defines no `toJSON()`.** `JSON.stringify` calls a value's own `toJSON()` **before**
    the replacer, so an error class that defines one hands a logger whatever that method returns
    instead of the error. Seven backends define one, and all seven log
    `{"error":{"error":{code,message}}}` — doubly nested, no `stack`, no `cause` — from a line that
    still looks like a log line. Our replacer recovers a foreign class from the holder; the fix for
    our own class is not to have the method.
23. **The mask is by CODE, not by status.** `maskedCodes` defaults to `["INTERNAL_ERROR"]`. Masking
    every 5xx flattens a `SERVICE_UNAVAILABLE` into a generic 500 and takes away the one thing
    telling a client whether to wait — in one adopter it made five authored 503 messages, one of
    them written in three locales, unreachable copy. **That default is safe because of the call
    sites, not because of this code**: it holds only while every non-masked 5xx carries a sentence
    somebody wrote for a client. A repo whose repository layer interpolates the driver's message
    wants `maskAll`.
24. **A 429 factory must state its wait, and `null` is one of the answers.** `createAppError` reads
    the literal types of your code→status map, so a 429 arm cannot compile without `retryAfterSecs`
    — which is cheap, because 34 of 40 raises across the fleet already stated one. `null` is the
    other half and the six durable caps are what proved it necessary: a concurrency slot frees when
    somebody else's job ends, and a cap on live objects clears by archiving one. A required `number`
    would have forced both to invent one. **An omission is invisible in a diff; a `null` is a claim
    somebody has to read** — and it is the claim that lets a client delete its hand-maintained list
    of durable codes.
25. **The mask is bound once, at the edge.** `createErrorResponse` returns the function every door
    imports — the API, a tool wrapper, a worker's health port. The reading found the alternative:
    four places in one fleet deciding the mask separately, and the one furthest from the API getting
    it wrong.
26. **A log line's error slot allow-lists what a non-`Error` may contribute.** A deny-list has to
    know `payload`, `header`, `raw`, `command`, `where` and the next vendor's word for it, and it
    learns each one from an incident. Measured: a webhook error carries the unverified request body,
    so an unauthenticated route let anyone on the internet write into the log; a Redis AUTH failure
    carries the password in `command.args`; and a Postgres `DatabaseError` carries statement text
    with its literals in `where` and `internalQuery` — reproduced on Postgres 18 with an e-mail
    address and a card number in it. **`stack` is kept**, because a job that dies crosses its queue
    through a serializer and arrives as a plain object, in the one line whose job is to say which
    job died and why.
27. **`assertEveryRouteGuarded` probes the router, and refuses an app with no endpoints.** It asks
    the real matcher which handlers run before each route, rather than reading the code, so a guard
    mounted on the wrong prefix is caught. The empty-app refusal is the important line: a check over
    zero routes passes by asking nothing, which is a guard that has never fired dressed as a green
    one.
28. **The package binds a code union at the RAISE site and cannot bind it at the CATCH site — so an
    adopter with a closed code list writes two lines, and needs to be told.** `createAppError` reads
    a status map's literal types, so a raise is checked. `AppError` and `AppErrorOptions` are
    generic with `= string` defaults, because this package ships no code list; re-export either name
    plainly and every `: AppError` annotation in the adopter becomes `code: string` and every
    factory's `messageKey` widens out of its union. That is silent — it compiles, it passes, and the
    next `switch (err.code)` simply stops being exhaustive. One adopter had **fourteen** such
    annotations and exactly one line the compiler could object to (`EXHAUSTED.has(err.code)`), so
    thirteen would have downgraded with nothing to show for it.

    A function cannot return a type, so there is no version of `createAppError` that closes this.
    What the package owes is the recipe, and it costs nothing because **TypeScript keeps types and
    values in separate declaration spaces**:

    ```ts
    import { AppError as PkgAppError } from "@gusnips/server";
    import type { AppErrorOptions as PkgAppErrorOptions } from "@gusnips/server";

    export const AppError = PkgAppError; // what you `instanceof`
    export type AppError = PkgAppError<ErrorCode, MessageKey>; // what annotations resolve to
    export type AppErrorOptions = PkgAppErrorOptions<MessageKey>;
    ```

    One name, no rename across call sites, and no cast. An adopter whose codes are open needs none
    of it — which is why this is an adopter's line and not a change to the generics' defaults.

29. **Only auth ANSWERING "no" ends a session, and the vendor's own predicate is not enough to
    tell.** `isAuthOutage` lives behind `/supabase` because it imports `@supabase/supabase-js`.
    Every browser client in this fleet reads a 401 as a dead session and signs the person out, so
    a 401 has to mean Supabase looked at the token and refused it; answer an outage with one and a
    single bad minute at auth signs out everybody who was signed in, while the refresh they are
    all waiting on is still in flight.

    The shape is `isAuthRetryableFetchError(error) || status >= 500`, and **the second clause is
    the load-bearing one**. The usual argument for keeping it is drift — the vendor's list was
    `[502, 503, 504]` at auth-js 2.91 and `[500-504, 520-530]` at 2.113.0 — and that argument
    invites "then pin a recent version and drop the clause". The argument that survives: it is a
    LIST, not a range, so it has holes at every version ever shipped. Nothing for 505 through 519,
    nothing from 531 up. A 507 or a 599 out of a proxy in front of GoTrue arrives as a plain
    `AuthApiError` and the vendor's predicate answers false for it, at every version.

    **Twelve backends wrote this predicate before the package did, and all twelve are correct —
    the export is for the comment, not the code.** Measured 2026-09-21 against `origin/main`, with
    the predicate checked as CALLED at the door rather than merely defined. Ten of the twelve
    carried a vendor-version sentence inline, and three of those had gone false by the time anyone
    re-read them; one of the three carried no number at all, which is how it escaped a gate
    written to catch the other two. Three lines of code deduplicated is a bad trade. A sentence
    that has silently gone wrong three times, collapsed to one copy with a test that executes the
    claim, is the whole point.

    **That test asserts the claim, never the numbers.** It pins that a 507 is refused by the
    vendor and caught by us, so it goes red the day the vendor switches to a range — which is the
    day the comment needs rewriting. A version sentence nothing executes is exactly the failure
    above. And it does not build an `AuthApiError` with a 502 on it to stand for "GoTrue answered
    502": auth-js reads its own list in `lib/fetch.js` and hands you an `AuthRetryableFetchError`
    for a LISTED status, so that shape is one the SDK never produces, and a test written that way
    passes for a reason its comment gets wrong. That exact mistake already shipped in this fleet
    and had to be corrected.

    **One shape it cannot catch, and the false is a decision.** auth-js raises `AuthUnknownError`
    when the body does not parse as JSON AND the status is off the list, and that subclass never
    fills the status — so a 507 from a proxy answering HTML is indistinguishable from a malformed
    400 and both read as "not an outage". Widening on the class name was declined: it is raised at
    ANY status, so it would call the malformed 400 an outage too, and a dead session that reads as
    retryable is the same failure from the other side — nobody signed out, and nobody able to sign
    in either. Neither direction is measured, so the narrow answer stays with the analysis beside
    it. The property is also PRESENT and `undefined` rather than absent, because the base
    `AuthError` defines it, which is worse: `"status" in error` answers true and tells you nothing.
    That is why the helper narrows on `typeof === "number"`. The first draft of that test asserted
    "no status at all" and went red — a claim written without measuring, caught by the assertion
    written to pin it.

    Takes `unknown`, not `AuthError`: the fleet asks this from three shapes and only one is
    narrowed. The door holds `AuthError | null` straight off `getUser`; the `catch` around a user
    lookup holds whatever was thrown. The vendor's predicate is itself `(error: unknown)` and
    duck-types on `__isAuthError` plus `name`, so it answers false for `null`, a number, a string,
    a bare `{}` and an ordinary `Error` — measured, not assumed, and the duck-typing is also why
    it keeps working when two copies of the SDK are installed.

30. **A pool with no `connectionTimeoutMillis` does not fail — it goes quiet.** `createPgPool`
    lives behind `/pg` because it imports `pg`, which a Worker cannot run. Read in
    `pg-pool@3.14.0` rather than inferred: with that option unset, a caller that finds the pool
    full is pushed onto `_pendingQueue` **with no timer at all** and waits until a connection
    frees. `max` defaults to 10, so ten slow queries at once are enough — auth, billing, the
    workers and `/health` all hang, with no error, no log and no metric. It is not a 500, it is
    silence, and silence is why it survives in a codebase.

    **Measured 2026-09-21 across `origin/main`: one backend of eleven bounded it.** That one had
    a feature holding a connection across an advisory lock, which turned the latent case live and
    is the only reason anyone looked. The other ten are standing on it. So the default is the
    export — a caller who writes nothing gets 10 seconds, and `connectionTimeoutMillis: 0` is
    still available for a batch job that would rather queue than fail. Spelled out, it is a
    decision; omitted, it is the shape of an accident.

    **`onIdleError` is required by the type, not an option.** All eleven wrote that listener and
    all eleven wrote a comment calling it mandatory, because a `Pool` with no `error` listener
    turns a server closing an IDLE client into an uncaught exception, and a backend whose crash
    handler exits is then killed by a connection nobody was using. Eleven correct copies plus one
    comment each is exactly the case a required field closes for the twelfth.

    **`pingPool` is bounded and the timer is cleared.** A raw `SELECT 1` hangs `/health` when the
    database hangs — which an orchestrator reads as "unknown" where `false` would have meant
    "replace this container"; `connectionTimeoutMillis` does not cover it, because that bounds
    getting a connection and not the query once you hold one.

    **Both counts this paragraph first carried were low, and re-measuring during the sweep is what
    corrected them.** It said four backends ran `SELECT 1` raw; it is **eight of eleven**, in two
    different PLACES — four in the pool module, and four with no probe there at all because theirs
    is inlined in `GET /health` in `apps/api/src/app.ts`. That second group is the lesson: a sweep
    that patched every pool file reported itself complete and had not touched them, because **a
    per-file check answers for the file and not for the bug.** What caught it was asking the fleet
    the question the sweep claimed to have closed, rather than counting the commits it produced.
    And it said one copy was bounded-but-uncleared; it is **three**, and all three left the
    `setTimeout` running, so a process probed every few seconds carried a live timer per probe.

    **What did NOT come across, and why.** The `ssl` rule: `@gusnips/migrate` already exports
    `pgSsl`, and the nine hand-written copies were byte-identical in the body — only their
    comments differed, and they differed about WHY Supabase cloud goes unverified. The pool
    **singleton**: every copy wrapped one in a module-level `let`, and a package that holds it
    decides when your process can exit. `connectWithRetry`: four copies, and its `maxAttempts =
Infinity` default turns a typo'd `DATABASE_URL` into a boot that hangs instead of one that
    fails. Type parsers: a global side effect on the `pg` module, and a product decision about
    what a `numeric` column means.

31. **A peer used only for its types is optional, and a sentence saying so is not the
    declaration.** `@gusnips/http` was a REQUIRED peer while being imported in exactly two files,
    both `import type`. Verified the way frontkit's invariant 15 prescribes — against the BUILT
    output, never the source: zero occurrences in any emitted `.js`, and only `.d.ts` references,
    because types erase.

    The cost lands on the adopter who wants the narrowest subpath. `/pg` is a pool factory that
    imports `pg` and nothing else, and taking it meant installing a second package whose code can
    never run. That is what found this: of the ten backends standing on invariant 30's silent
    pool, four carry no `@gusnips/server` at all, so the one-line fix would have arrived as two
    new dependencies.

    **The tell was in our own preamble, one line above the word "required": "only its types,
    which erase".** A document that states the reason a rule is unnecessary, beside the rule, is
    the shape this invariant exists to catch — and it had been read past for four releases.

    **The risk is `skipLibCheck`, and it is measured rather than assumed.** With the peer optional,
    an adopter who uses the `"."` entry and does not install `@gusnips/http` has tsc resolve a
    `.d.ts` reference to nothing. All four of those repos set `skipLibCheck: true` in the
    `tsconfig.base.json` every other config extends, so nothing breaks for them; where it is off,
    the error moves from install time to typecheck time, which is the direction invariant 15
    warns about, and is why this paragraph exists instead of a shrug.

    This is invariant 15 read from the other end. There, an optional peer the barrel imports
    anyway is a required peer with its error moved somewhere worse. Here, a required peer nothing
    imports is an optional peer charging every adopter for a package it never loads. One test,
    the built import graph; opposite answers.

32. **`maxRetriesPerRequest: null` is required by BullMQ, so every read on that connection must
    carry its own bound.** It is the mirror image of invariant 30 and that is the whole point of
    writing it beside it: there the DEFAULT is the silent unbounded wait and `createPgPool`'s job
    is to replace it; here the unbounded wait is the CORRECT setting, because BullMQ's blocking
    reads must never be cut short by a retry limit, and every copy in the fleet sets it
    deliberately. What does not follow, and what nobody wrote down, is that the same connection
    then serves the queues, the limiters, the cache and the health probe — so a `ping`, a cache
    lookup or a `queue.add()` against a down Redis does not fail, it waits.

    **Four backends bound their `PING` exactly right and are safe only because of it. All four
    then leaked the timer** — `Promise.race` against a `setTimeout`, no `clearTimeout` anywhere —
    which is a pending 2-second timer per health check in a process something probes every few
    seconds. `pingRedis` clears it in a `finally`, the same as `pingPool`.

    **And one backend shows what the unbounded half costs when nothing bounds it.** It enqueues
    inbound webhooks on a connection like this with no bound on the enqueue, so during a Redis
    outage every webhook holds its HTTP connection until the caller gives up — while its
    `/health`, which probes Postgres only, stays green. Two separate faults: a health check that
    cannot report the dependency, and a write with no deadline. Fixing the first does not fix the
    second, and reading the config comment is what separates them — it says, out loud, that the
    command timeout was "removed to allow BullMQ operations to complete properly".

    **And the `null` could be undone from the URL, with nothing in the code to show it.** ioredis
    reads options from `REDIS_URL`'s query, lets them beat the options passed beside it, and keeps
    each as a string, so `?maxRetriesPerRequest=7` replaced the kit's `null` and
    `?enableOfflineQueue=false` arrived as the string "false", which ioredis reads as on (measured
    on 5.11.1, under bun and node). One backend refused any query in the URL; `createRedis` does
    now, and a test pins the ioredis behaviour, so the guard's reason is checked rather than
    remembered. It refuses the whole query, not only the keys it passes itself, because a string
    value is wrong even where nothing collides. The message names no key: in a URL whose password
    holds an unencoded `?`, the "key" is the rest of the password.

    The connection factory behind all of this was **byte-identical in four backends**, comment
    included, and one of those comments says out loud that it was copied from a sibling repo —
    including the half of it that is false. All four state that an EventEmitter with no `error`
    listener throws, so a blip becomes a process exit through a crash handler. **Measured on
    ioredis 5.10.1, the version the whole fleet runs, under bun 1.3.8 and node 22: the process
    survives and `uncaughtException` never fires.** `silentEmit` in `Redis.js` checks
    `this.listeners(eventName).length` and, finding none, calls `console.error("[ioredis]
Unhandled error event:", ...)` and returns — it never emits, so Node's throw is unreachable by
    construction.

    `onError` stays required for the reason that survives: that `console.error` is a bare stack on
    stderr, outside the logger the app ships every other failure through, and `silentEmit` drops
    the event entirely once the client's status is `end`. **Invariant 30's `onIdleError` is not
    the same case and must not be corrected with it** — checked the same way rather than assumed,
    `pg-pool` calls `pool.emit("error", err, client)` with no listener-count guard anywhere, so
    there the listener really is what stands between an idle-client error and a crash. Copying one
    library's sentence onto another is the whole mechanism here, and four repos copying it is what
    made it look measured. **A sentence four files agree on is still one observation.**

33. **A URL a customer names is checked at every hop, before the hop is sent, and the request
    goes to an address that was checked.** Twelve backends wrote this guard in six independent
    lineages, and each of the three halves was missing somewhere. One followed redirects with
    `redirect: "follow"` and checked only where they ended, so a listener on loopback received
    the request before the check ran (measured). One judged an IPv4-mapped IPv6 address only in
    its dotted form, and `new URL` writes it in hex, so `::ffff:7f00:1` read as public. Five
    checked a name and then let `fetch` resolve it a second time, which is the gap DNS
    rebinding lives in. So `nextHop` re-checks the next URL before anyone dials it, IPv6 is an
    ALLOW-list (2000::/3 minus the blocks that embed an IPv4 address), an address that does not
    parse is not public, and `pinnedRequest` sends to the literal it was handed. A name with one
    private answer among public ones is refused as a whole, which is what makes every surviving
    address equally safe to dial. `allowLoopback` relaxes loopback and nothing else, because two
    donors had a flag that skipped the whole guard and nothing refused it in production.

34. **The pinned dial rests on a runtime fact, and Bun 1.3.8 gets it wrong.** It sends to the IP
    literal and puts the name in `servername` and in `Host`. Measured with a local CA and against
    a public host: Node 22.22 and Bun 1.4.2 check the certificate against `servername`, refuse a
    wrong one, and fall back to `Host` when there is none. Bun 1.3.8 ignores `servername` and
    checks `Host` verbatim, port included, so an https URL on any other port than 443 is refused.
    It also re-sends a request on its own when a reused connection is reset, so a POST can arrive
    twice. The test file fails in exactly those two places on 1.3.8 and passes on the other two,
    run with each runtime's own `--bun`. One donor's comment credits `tls.serverName` with the
    check, measured against a public host on 1.3.8; that runtime was reading the `Host` header,
    which the donor had also set to the name. Its pinning was safe for a reason other than the
    one it wrote down. **A measurement that agrees with you can still be measuring
    something else.** The same matrix settled a smaller question: under 1.3.8, aborting a
    gzip body ended it early when the REQUEST was destroyed and failed it when the RESPONSE was,
    so `dial` destroys the response once there is one.

35. **A limiter says what a store outage means, and a count that crosses the network has a
    deadline.** Three limiters in the fleet were documented "fails open" and hung instead: the
    shared connection has `maxRetriesPerRequest: null`, which BullMQ needs, so a MULTI against a
    Redis that is down never answers and the `catch` that would allow the request is never
    reached. Measured against a closed port, it was still pending after 15 seconds. So
    `redisWindowStore` takes a required `timeoutMs`, and `whenStoreFails` is required for any store
    that can fail. It has no default, because the fleet uses both answers on purpose: a limit that
    guards a promise allows, and one that guards a bill or a stranger's inbox refuses with the
    product's own 503. The memory store cannot fail, so the types do not ask it. The count and its
    expiry go in one MULTI, because the copy that sent `EXPIRE` separately can lose it and leave a
    key over the limit forever. And the memory store sweeps once per closed window rather than
    once per request: the donors that shed walked all 50,000 keys for every new one while full,
    measured at 3.8 ms of event-loop time per shed request, which made the shed the flood's tool.

36. **A client's address comes from the socket, and a header only from the proxy that wrote it.**
    Most of the fleet read the last `X-Forwarded-For` hop, which is right behind the proxy and only
    there: six APIs listen on every interface, and unless a firewall closes the port, a caller that
    reaches it directly writes that hop itself and picks its own rate-limit window. The one reader
    that asked the socket first then read `X-Real-IP` ahead of the header, and its proxy passes a
    client's own copy through (Caddy's documented default; no Caddy was run to measure it), so the
    header list is a closed type with no `X-Real-IP` in it. Two measured facts shape the rest. On a
    dual-stack socket Bun reports an IPv4 client as `::ffff:127.0.0.1`, so the loopback test folds
    the mapped form first, where a `startsWith("127.")` misses the proxy. And `hono/bun`'s
    `getConnInfo` throws for a request that did not come through `Bun.serve`, so a `peerOf` that
    throws reads as no peer rather than failing every in-process test. No address is `null`, not
    `"unknown"`: seven readers put every such request in one window that one caller could fill for
    everyone.

37. **A webhook is checked against its age and against every signature in it, and an unset secret
    refuses.** Three verifiers in the fleet never compared the timestamp to the clock, one of them
    the recipe a product publishes to its customers, so a captured delivery passed forever. Standard
    Webhooks separates signatures with a space and Supabase Auth with `", "`: the verifier that
    split on one space refused every auth hook whenever its secret was the first of two (measured),
    and another kept only the last `v1`, so it could not verify during a rotation. Both formats now
    try every signature against every secret, and they share only the HMAC and the comparison,
    because a fix to one must not change the other. An unset secret is refused by the code, never
    left to the runtime: `safeEqual("", "")` answered `true` in five copies, and Node's `createHmac`
    signs with an empty key where Web Crypto refuses one, so a check that leaned on the runtime was
    closed on Bun and open on Node (measured with the Stripe SDK the fleet pins). And a multibyte
    signature fails rather than throws: one copy compared string lengths and then bytes, which is a
    `RangeError` any stranger could raise.

38. **A stored secret is sealed under a key id, with a 16-byte tag, and a key checked at boot.** Six
    copies in four shapes, and none could rotate: each held one key, and two wrote `v1` in front of
    every value and refused anything else. That `v1` is now a key id, so those two backends' rows
    open unchanged (tested against their `node:crypto` code, in both directions), and a second key
    is a rotation rather than a migration. Node accepts a GCM tag cut short unless it is told the
    length, and one copy opened a value with a 4-byte tag (measured), so the sealer refuses any tag
    but 16 bytes. An empty string seals and opens, where two copies threw. A key must decode to 32
    bytes, checked when the sealer is made: four copies checked only that the variable was set, so a
    one-letter key booted. Each key is imported once, where one copy ran scrypt on every call, at
    least 67 ms of blocked event loop each on the path that handles every inbound message. The keys
    sit in a `Map`, so a stored value naming its key `constructor` finds no key rather than
    Object's. `scryptSealKey` is the one piece in `/node`, because Web Crypto has no scrypt on Node
    or on Bun (measured).

39. **A token the server hands out carries its purpose in the key, and says `expired` only of its
    own signature.** Twelve copies from six derivations. Five backends derive the signing key as the
    HMAC of a service key and a purpose label, so the service key never signs and two doors cannot
    share a token; three other designs signed with an encryption key, and one with the service key
    itself. The kit takes the first design, and without an expiry its token is byte-for-byte theirs,
    because an unsubscribe link must keep working in mail already sent (tested against their
    formula, both ways). An expiring token adds a signed middle segment, and since a payload holds
    no dot, no token can be recut to drop or move its expiry. The signature is checked before the
    expiry, so a "this link expired" page is only ever shown for a token the server signed. The
    shape is checked first, so a token that passes is base64url, digits and dots, safe to write back
    into a page. One design binds an outside value, a username, into its signature. Here that would
    be a hole: MAC-ing `<payload>.<value>` lets a caller who picks the value move the expiry into it
    and drop it. So the value goes in the payload and is compared after verifying.

40. **The environment is checked in one pass, with no value in any message, and a placeholder secret
    stops the boot.** Twelve validators in the fleet, 30 to 60 lines of mechanism each; the list of
    variables stays with the product. One threw at the first problem, so a box with two took two
    restarts. One said a value must never reach the message, because a connection URL carries a
    password, and the kit's messages hold names and lengths only. None of the twelve refused the
    value its own `.env.example` ships. The shapes were measured on the secret lines of every
    `.env.example` the fleet commits: `your-…` (also behind a vendor prefix, `sk-your-…`), `<…>`,
    `…-xxx`, `generate-…`, `change-me` and `dev-only`. A length floor does not catch them: the
    `JWT_SECRET` two repos carry in their self-hosted Supabase example is
    `your-super-secret-jwt-token-with-at-least-32-characters`, 55 characters written to pass the
    floor it is checked against, and one repo's example key passes that repo's own 32-character
    floor. So `secrets` refuses the shape before it measures the length. Only keys named as secrets
    are checked for a placeholder: a secret is random, so a word in it is a placeholder, where
    `EMAIL_FROM` holds words and brackets by design. The source is an argument, because a Worker has
    no `process.env`, and a Worker binding counts as set. Nothing turns the check off: one copy
    returned early under `NODE_ENV=test`.

41. **An API's headers go on outside `errorBoundary`, and CORS compares whole origins.** Seven Hono
    APIs pasted one `secureHeaders` option set word for word, and all seven mounted it inside
    `errorBoundary`. `secureHeaders` writes after `next()`, and a throw that is not an `Error` skips
    that step in every middleware between the throw and the boundary, so a plain-object throw (a
    PostgREST rejection) answered 500 with no HSTS, `nosniff` or CSP (tested in both orders).
    `errorBoundary`'s own doc said to mount it right after `requestLogger`, which is the order that
    loses them; it now names what goes before it. CORS headers survive either order, because `cors`
    sets them before `next()` and Hono copies them onto the answer, so the reason two APIs gave for
    mounting CORS first does not hold on hono 4.13.8. `corsAllowList` compares whole origins, where
    one API matched with `endsWith` and `includes` and let in any site on `pages.dev` (measured). An
    entry that is not an origin throws at boot, and so does one with an opaque origin: that origin
    is the string "null", and allowing it allows every sandboxed iframe. `Retry-After` and
    `X-Request-ID` are always exposed, because a browser hides both from the page otherwise.
    Credentials are off, because no Hono API in the fleet sets a cookie. A preflight is kept 600
    seconds, where the Fetch spec's default is 5. `bodyLimit` needs no wrapper, but it reads a
    chunked body whole before `next()`, so the README puts every check that needs only headers in
    front of it. Bun's default body cap is 128 MiB on 1.3.8 and on 1.4.2 (measured).

42. **A drain runs once, in the order it is given, under a backstop that holds the process open.**
    Thirteen hand-written drains had four defects between them: a worker that always exited 0,
    ten APIs that ran the whole sequence again on a second signal (pg-pool's `end()` then
    rejects), backstops shorter than the work they drained, and a cron nobody could stop. Every
    copy `unref`'d its backstop, and that is a fifth, which none of them knew: when a step hangs
    holding no socket, an unref'd timer lets the process exit 0 in the middle of the drain with
    nothing logged (measured on Node 22, Bun 1.3.8 and Bun 1.4.2). The sequence always ends in
    `exit`, so a live timer keeps nothing alive for longer, and the backstop names the step it
    caught. Bun's `stop()` never resolves while an SSE client is attached, which is why
    `bunServerStep` bounds it; Bun 1.3.8's `stop(true)` does not close that connection either
    (curl still connected 20 seconds later, measured; 1.4.2 closes it at once), so the forced
    stop is bounded too and the steps after it still run. `rejections` is required, because the
    fleet uses both answers on purpose, and a rejection listener is installed for both: on Bun a
    rejection with only an `uncaughtException` listener exits 1 at once, skipping the drain,
    where Node hands it to that listener (measured on 1.3.8 and 1.4.2). An uncaught exception
    drains and exits 1 rather than exiting at once, because the backstop already bounds a drain
    the bug has broken. A second signal exits 1 at once: a process manager sends one and then
    SIGKILL, so the second comes from a person. The budget check stays in the adopter, because
    only the adopter can read its process manager's config; the README gives the order.
43. **A job is final when BullMQ says so, and a finished job is deleted unless you say otherwise.**
    Six `bullmq.ts` copies, four dead-letter files and five schedule syncs, 1,170 lines, and each
    bug in them was one copy missing what another knew. Retention: one backend's Redis reached
    about 16 GB and 14.9 million keys before it set any, and its operator scripts still add jobs
    through a bare `Queue` with none, so the worker sets it too, and a job that chose nothing gets
    the worker's (measured). Final: three of five dead letters counted attempts, and missed the
    failures that end on attempt 1 of 3: an `UnrecoverableError`, a backoff that answers -1, and a
    job that stalled past its limit. BullMQ stamps `finishedOn` only on the branch of
    `moveToFailed` that will not retry, so it answers all three without knowing why the job failed
    (measured on 5.76.4 and 5.81.5, the two ends of the fleet). The stall retry matches BullMQ's
    exact sentence, because one copy matched the word "stalled" and re-ran jobs that failed on their
    own. The schedule sync removes every scheduler its table does not name with one
    `removeJobScheduler`, which also removes an old-style repeat and its delayed job (made on
    5.12.0, removed on 5.76.4 and on 5.81.5), so the donors' `removeRepeatableByKey` branch goes.
    A run that was already due when its scheduler went still runs, once. A cron pattern takes a
    `tz` by type, because one copy ran on the box's clock.

    **This build believed one thing that was false, and a planted defect is what caught it.** A
    probe showed BullMQ refusing `"a:b"` as a custom id, and three donors name their dead-letter
    record `${queue}-${job.id}`, where a scheduler's job id is `repeat:<id>:<ms>`. So the claim was
    that those records are refused and a maintenance job's final failure is lost. BullMQ refuses a
    colon unless the id has exactly two, kept for the old repeat ids, and `maint-repeat:x:123` has
    two. The defect that put the donors' id back survived the suite, and that is the only reason the
    claim never reached a commit. The record here still takes the id BullMQ gives it, for a smaller
    reason: a job id that fails for good twice is recorded twice.

44. **A login never crosses in clear, and every wait on a mail server has a deadline.** Nine
    senders, seven of them pastes of one file. nodemailer upgrades port 587 to TLS only when the
    server's reply to EHLO offers STARTTLS, so somebody on the path who deletes that word gets the
    password: measured against a server with STARTTLS hidden, the login crossed as plain text on
    nodemailer 6.10.1, 7.0.13 and 10.0.10, on Node 22, Bun 1.3.8 and Bun 1.4.2, and `requireTLS`
    stopped it on all nine. One product sets it, in the lanes that dial its customers' mailboxes;
    no system-mail sender does.
    So a login sets `requireTLS`, and no login (a local catcher) does not, which is the only case
    that needs plain text. 12 of 13 senders set no timeout, so nodemailer's 2 minutes to connect
    and 10 minutes of silence applied inside requests somebody was waiting on; one number now
    bounds each wait, and the `ponytail:` in the file names what it does not bound. The text part
    is required because one sender sent HTML only. The one-click header pair is a pure function at
    the root, tested on the bytes that went out, because two senders passed nodemailer's `comment`
    form and tested the options object, which put the second header inside the first.

    **Port 587 is safe on Bun, and the reason is narrower than "Bun is fine".** Bun #32239 keeps a
    copy of the ciphertext on the plain socket after a STARTTLS upgrade, and a sibling project moved
    a whole IMAP worker to Node over it. Measured: the copy appears only while the plain socket is
    paused (43 bytes on Bun 1.3.8 and 1.4.2 when the probe paused it, 0 on Node), and nodemailer
    leaves it flowing, so five sends each on both Bun versions went out intact with nothing
    buffered, and the TLS handshake with two public providers on 587 buffered nothing. The IMAP
    smoke test that found it calls `unpipe()`, which pauses the socket. Anything here that drives a
    socket itself and pauses it is back under the bug.

45. **An MCP tool never throws, a limit counts tool calls, and one guard covers both spellings of
    the door.** Eight backends, eight doors, no file-level paste among them, and every fix lived in
    one or two. The SDK (1.29.0 to 1.30.1) catches a handler's throw and answers `err.message` as
    the tool's result, on a 200: three doors rethrew what they could not place, with a comment
    saying the rethrow reached the log, so a driver's `ECONNREFUSED` with an internal address went
    to the agent and no line was written. `registerOperation` answers every `kind` through
    `errorResponse` and logs the raw error for `server` and `unexpected`, as REST does. One POST
    may carry a JSON-RPC batch, and the stateless transport runs every call in it, concurrently,
    under every protocol version, including those that dropped batching (measured with 50): six
    doors limited the POST. So the limit is `beforeCall`, required, with `null` to decline, the
    same shape as `whenStoreFails`. Handed a `.shape`, the SDK parses with a loose object and
    strips an invented key before the handler's own `.strict()` can see it, so `inputSchema` is
    `AnySchema` and a shape does not compile. A GET on the stateless transport answers a stream
    nothing writes to, held until the idle timeout (180-255 s in the fleet), so it gets a 405.

    **The spelling half is two Hono facts, and fixing the first creates the second.**
    `app.route("/mcp", sub)` folds `""` and `"/"` into `/mcp`, so a sub-app serves one spelling:
    five doors answered `/mcp/` with a 404 under a comment claiming both. And
    `app.use("/mcp", guard)` matches `/mcp` exactly, so a door serving both behind that guard
    serves `/mcp/` with no key. Measured on Hono 4.12.26 and 4.13.8: `"/mcp/*"` covers `/mcp`, `/mcp/` and `/mcp/x`. No
    door had the second bug, because the two serving both spellings also guard `"/mcp/*"`. That is
    why the README states the guard and the mount together, and a test pins both statuses.

    `registerOperation` takes `ToolOperation<Deps, unknown, unknown>`, not a generic `Args`. A
    catalog of different operations is a union, and inference over a union argument picks one
    member and refuses the rest, which is exactly the loop four doors write. `run` is a method, so
    it is compared both ways, and `{ id: string }` stands where `unknown` is asked for with no cast,
    also from an app's own operation type whose `run` is a property (tested).

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
