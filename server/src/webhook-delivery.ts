/**
 * What to do after one attempt to deliver a webhook: it arrived, try again in N seconds, or stop.
 *
 * Seven senders in the fleet each wrote this decision, and each got a different part of it wrong:
 * - **A 4xx was retried by six of them.** The receiver's code answered on purpose, and the same
 *   bytes get the same answer. Only 408, 425 and 429 mean "not now".
 * - **No sender read `Retry-After`.** A receiver that said "in 60 seconds" got the next attempt
 *   at 30, which spends an attempt on an answer it already gave.
 * - **Redirects were handled three ways.** A webhook follows none, because a redirect is an
 *   address nobody checked, so the next attempt gets the same redirect. It stops at once, with a
 *   reason that tells the customer to register the final URL.
 * - **The ladder was a list in one, a doubling in five, and a flat 30 s in one, by accident**,
 *   which gave up about two minutes into a receiver's outage. One doubling started at 5 s and gave
 *   up after about 15.
 *
 * The attempt count is the caller's, kept on the delivery row: a queue that delays a job by hand
 * does not count it as an attempt, and the row is what a customer reads.
 */

export interface DeliveryPolicy {
  /** Attempts in all, the first one included. Default 5. */
  attempts?: number;
  /** The wait after the first failed attempt. It doubles after each one. Default 30. */
  baseSecs?: number;
  /**
   * The longest wait, whether the ladder or the receiver's `Retry-After` asks for more. Default
   * 3600. A receiver asking for three hours gets an attempt each hour, which may land early, where
   * refusing the wait would give up on an event that was going to arrive.
   */
  maxWaitSecs?: number;
}

export type DeliveryStep =
  | { outcome: "delivered" }
  | { outcome: "retry"; afterSecs: number }
  | {
      outcome: "failed";
      /**
       * `refused`: a 4xx other than 408, 425 or 429. `redirected`: a 3xx, which a webhook never
       * follows. `exhausted`: every attempt failed in a way waiting could have fixed.
       */
      reason: "refused" | "redirected" | "exhausted";
    };

/** "Not now": a timeout, "too early", and a rate limit. Every other 4xx is final. */
const LATER = new Set([408, 425, 429]);

/**
 * The step after attempt number `attempt` (1 for the first), from what the receiver answered:
 * the response, or `null` when nothing came back (a refused connection, a timeout, DNS failing).
 *
 *     const step = nextDeliveryStep(response, delivery.attempts + 1);
 *
 * Only a `failed` step counts toward a breaker. An attempt that will be retried is the same event,
 * and a receiver down for ten minutes should not use up ten of its failures on it.
 */
export function nextDeliveryStep(
  answer: { status: number; headers: Headers } | null,
  attempt: number,
  policy: DeliveryPolicy = {},
): DeliveryStep {
  const { attempts = 5, baseSecs = 30, maxWaitSecs = 3600 } = policy;
  if (!Number.isInteger(attempt) || attempt < 1)
    throw new RangeError(`attempt counts from 1, the attempt that just ran; got ${attempt}`);
  const status = answer?.status;
  if (status !== undefined && status >= 200 && status < 300) return { outcome: "delivered" };
  // `redirect: "manual"` hands some runtimes an opaque redirect, whose status is 0.
  if (status === 0 || (status !== undefined && status >= 300 && status < 400))
    return { outcome: "failed", reason: "redirected" };
  if (status !== undefined && status < 500 && !LATER.has(status))
    return { outcome: "failed", reason: "refused" };
  if (attempt >= attempts) return { outcome: "failed", reason: "exhausted" };
  const ladder = baseSecs * 2 ** (attempt - 1);
  const stated = statedWaitSecs(answer?.headers.get("retry-after"));
  return { outcome: "retry", afterSecs: Math.min(maxWaitSecs, Math.max(ladder, stated)) };
}

/**
 * The wait `Retry-After` states, in either form RFC 9110 allows: seconds, or an HTTP date, rounded
 * up so the next attempt is never early. Anything else, and a date already past, comes out at 0 or
 * below, where the ladder's wait wins.
 */
function statedWaitSecs(value: string | null | undefined): number {
  const raw = value ?? "";
  if (/^\d+$/.test(raw)) return Number(raw);
  return Math.ceil((Date.parse(raw) - Date.now()) / 1000) || 0;
}
