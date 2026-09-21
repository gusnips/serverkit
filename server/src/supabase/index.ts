/**
 * `@gusnips/server/supabase`: the decisions a backend makes about Supabase Auth's ANSWERS.
 *
 *     const { data, error } = await supabaseAnon.auth.getUser(token);
 *     if (isAuthOutage(error)) throw errors.serviceUnavailable("Authentication service unreachable");
 *     if (error || !data.user) throw errors.invalidToken();
 *
 * Behind a subpath because it imports `@supabase/supabase-js`, which the main entry does not and
 * a Hono-only adopter should not have to install.
 */
import { isAuthRetryableFetchError } from "@supabase/supabase-js";

/** A `status` if the value carries a numeric one, else 0. Narrowed rather than cast. */
function statusOf(error: unknown): number {
  if (typeof error !== "object" || error === null || !("status" in error)) return 0;
  return typeof error.status === "number" ? error.status : 0;
}

/**
 * Did auth FAIL to answer, rather than answer "no"?
 *
 * Only answering "no" ends a session. Every client in this fleet reads a 401 as a dead session
 * and signs the person out, so a 401 has to mean Supabase looked at the token and refused it.
 * Answer an outage with a 401 and one bad minute at auth signs out everybody who was signed in —
 * while the refresh they are all waiting on is still in flight.
 *
 * **Both clauses, and the second is the load-bearing one.** `isAuthRetryableFetchError` reads a
 * list the vendor owns and has rewritten more than once: `[502, 503, 504]` at auth-js 2.91, and
 * `[500-504, 520-530]` at auth-js 2.113.0, unchanged at the 2.116.0 this package develops
 * against. The usual argument for keeping a check of our own is that drift — and it invites the
 * obvious reply, "then pin a recent version and drop the clause".
 *
 * The argument that survives the reply: it is a LIST, not a range, so it has holes at every
 * version ever shipped. Nothing for 505 through 519, nothing from 531 up. A 507 or a 599 out of
 * a proxy in front of GoTrue arrives as a plain `AuthApiError`, and the vendor's predicate
 * answers false for it — at every version, not just at the stale one.
 *
 * Do not trust the numbers in this paragraph; re-measure them. The list lives in auth-js's
 * `lib/fetch.js` as `NETWORK_ERROR_CODES`, and `bun why @supabase/supabase-js` tells you which
 * version you actually resolve. The test beside this file asserts the CLAIM rather than the
 * numbers — a 507 that the vendor refuses and this predicate catches — so it goes red the day the
 * holes are gone and this paragraph needs rewriting, which is the only kind of version comment
 * that can be trusted. Twelve backends wrote this predicate and ten of them carried a
 * version sentence inline; three of those sentences had gone false by the time anyone re-read
 * them, and one of the three carried no number at all, which is how it escaped a gate written to
 * catch the other two. This is the copy that gets to be wrong, because it is the only one.
 *
 * `unknown` rather than `AuthError`, because the fleet asks this from three shapes and only one
 * of them is narrowed: the door holds `AuthError | null` straight off `getUser`, and the `catch`
 * around the user lookup holds whatever was thrown. The vendor's own predicate is
 * `(error: unknown)` and duck-types on `__isAuthError` plus `name` — so it answers false for
 * `null`, a number, a string, a bare `{}` and an ordinary `Error`. Measured, not
 * assumed; the duck-typing is also why it still works when two copies of the SDK are installed.
 */
export function isAuthOutage(error: unknown): boolean {
  return isAuthRetryableFetchError(error) || statusOf(error) >= 500;
}
