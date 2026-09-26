/**
 * BullMQ queues and workers with the settings six backends each wrote, plus the dead letter,
 * the stall retry and the schedule sync that only some of them got right.
 *
 * What the copies taught:
 * - **BullMQ keeps every finished job forever unless told otherwise.** One backend's Redis
 *   reached about 16 GB and 14.9 million keys before it learned this. So retention is on every
 *   queue AND every worker: a job a script adds through a bare `Queue` still passes a worker,
 *   and the worker's retention covers any job that did not choose its own (measured).
 * - **A failure is final when BullMQ stamps `finishedOn`, not when attempts run out.** Three
 *   dead letters counted attempts, and missed the failures that end early: an
 *   `UnrecoverableError`, a backoff that answers -1, and a job that stalled past its limit. Each
 *   of those fails for good on attempt 1 of 3 (measured on bullmq 5.76.4 and 5.81.5).
 * - **Only a stall is safe to retry.** One copy retried any job whose reason contained the word
 *   "stalled", so a job that failed for its own reason ran again.
 * - **A time zone is part of a cron pattern.** One copy left it out, so its jobs ran on the
 *   box's clock.
 *
 * `bullmq` is an optional peer, and this subpath is the only place that imports it.
 */
import {
  MetricsTime,
  Queue,
  Worker,
  type ConnectionOptions,
  type Job,
  type JobsOptions,
  type Processor,
  type WorkerOptions,
} from "bullmq";

/**
 * How long finished jobs stay: completed ones for a day, up to 200; failed ones for a week, up to
 * 1,000, so there is time to look at them. Every queue and worker here sets it. Spread it into a
 * `FlowProducer` add, which takes no defaults.
 */
export const JOB_RETENTION = {
  removeOnComplete: { count: 200, age: 24 * 3600 },
  removeOnFail: { count: 1_000, age: 7 * 24 * 3600 },
} as const satisfies JobsOptions;

interface ConnectionOf {
  /**
   * Pass the one connection `createRedis` gave you. A worker makes its own copy for its blocking
   * reads and closes that copy itself; the one you pass stays open for your shutdown to close.
   */
  connection: ConnectionOptions;
  /** Where errors from the connection go. Required, so they reach your logger. */
  onError: (error: Error) => void;
  /** BullMQ's key prefix. Give each product its own when they share one Redis. */
  prefix?: string;
}

/** A queue whose jobs are kept for `JOB_RETENTION` unless a `defaultJobOptions` says otherwise. */
export function createQueue<T>(
  name: string,
  options: ConnectionOf & { defaultJobOptions?: JobsOptions },
): Queue<T> {
  const { connection, onError, prefix, defaultJobOptions } = options;
  const queue = new Queue<T>(name, {
    connection,
    // Only when set: BullMQ fills its default with `Object.assign`, so an undefined key beats it
    // and a job's `prefix` and the client names read "undefined".
    ...(prefix !== undefined && { prefix }),
    defaultJobOptions: { ...JOB_RETENTION, ...defaultJobOptions },
  });
  queue.on("error", onError);
  return queue;
}

/**
 * The name of the retry ladder every worker here can run: 5 s, 10 s, 20 s and so on up to 120 s,
 * each delay a random 50–100% of its step, so a burst of retries does not hit a server at the
 * same moment. BullMQ's own `exponential` has no cap, so a long ladder sleeps for hours. Ask for
 * it per job: `backoff: { type: CAPPED_EXPONENTIAL }`.
 */
export const CAPPED_EXPONENTIAL = "capped-exponential";

/** The strategy behind `CAPPED_EXPONENTIAL`. `createWorker` registers it on every worker. */
export function cappedBackoff(attemptsMade: number, type?: string): number {
  if (type !== CAPPED_EXPONENTIAL)
    throw new TypeError(
      `The backoff type "${type ?? "(none)"}" is not registered on this worker. Use ` +
        `"${CAPPED_EXPONENTIAL}", or BullMQ's own "fixed" or "exponential".`,
    );
  const step = Math.min(5_000 * 2 ** Math.max(0, attemptsMade - 1), 120_000);
  return Math.floor(step / 2 + Math.random() * (step / 2));
}

/**
 * A worker with the settings a deploy must not break:
 * - A job whose worker died is re-run twice at most before it fails, 15 to 90 seconds after the
 *   worker died: a live worker checks every 30 seconds, and re-runs a job only on the check after
 *   the one that marked it, once its 30-second lock has run out (measured 35 to 69 seconds after a
 *   `kill -9`). For a job that must never run twice, such as one that sends a mail, pass
 *   `maxStalledCount: 0` and give its jobs `attempts: 1`.
 * - Per-minute counts of completed and failed jobs are kept for two weeks, which is kilobytes.
 *   BullMQ keeps none by default, so `queue.getMetrics` has nothing to read.
 * - `JOB_RETENTION`, for jobs that did not set their own.
 * - `CAPPED_EXPONENTIAL` is registered.
 *
 * Every option you pass goes over these.
 */
export function createWorker<T>(
  name: string,
  processor: Processor<T>,
  options: ConnectionOf & Omit<WorkerOptions, "connection" | "prefix">,
): Worker<T> {
  const { connection, onError, prefix, ...rest } = options;
  const worker = new Worker<T>(name, processor, {
    metrics: { maxDataPoints: MetricsTime.TWO_WEEKS },
    stalledInterval: 30_000,
    maxStalledCount: 2,
    ...JOB_RETENTION,
    ...rest,
    settings: { backoffStrategy: cappedBackoff, ...rest.settings },
    connection,
    ...(prefix !== undefined && { prefix }),
  });
  worker.on("error", onError);
  return worker;
}

/**
 * For a `failed` listener: true when BullMQ will not run `job` again. It stamps `finishedOn` only
 * then, so this is right for the failures that end before the attempts run out, where counting
 * attempts is not.
 */
export function isFinalFailure(job: Job | undefined): job is Job & { finishedOn: number } {
  return job?.finishedOn !== undefined;
}

/** The states in which a job still holds its id. */
const LIVE_JOB_STATES = new Set([
  "waiting",
  "active",
  "delayed",
  "prioritized",
  "waiting-children",
]);

/**
 * Removes the job kept under an id you chose, unless it is still waiting or running, so the next
 * `add` with that id runs. BullMQ skips an add, without an error, while any job with its id
 * exists, and `JOB_RETENTION` keeps a finished one for up to a week. One backend's operator script
 * added a job under the id its live pipeline used, and that id then never ran again.
 *
 *     await removeLeftoverJob(await queue.getJob(`refetch-${id}`));
 *     await queue.add("refetch", { id }, { jobId: `refetch-${id}` });
 */
export async function removeLeftoverJob(job: Job | undefined): Promise<void> {
  if (job && !LIVE_JOB_STATES.has(await job.getState())) await job.remove();
}

/** What the dead letter keeps about a job that failed for good: enough to find it and re-add it. */
export interface DeadLetter {
  queue: string;
  jobId: string | undefined;
  name: string;
  data: unknown;
  attemptsMade: number;
  failedReason: string;
  stack: string | undefined;
  failedAt: string;
}

/**
 * Records each job `worker` gives up on in `deadLetters`, and returns a function that waits for
 * the records still being written. Call that in your shutdown, before the connection closes:
 * BullMQ does not wait for a `failed` listener.
 *
 *     const flush = wireDeadLetter(worker, deadLetters, { onError: (error) => logger.error(...) });
 *
 * Run a worker on `deadLetters` too. A record waits until one takes it, and that worker is where
 * you log it or tell a person. Leave out a worker whose job data holds a secret: the record keeps
 * the data for a week.
 */
export function wireDeadLetter(
  worker: Worker,
  deadLetters: Queue<DeadLetter>,
  options: { onError: (error: Error) => void },
): () => Promise<void> {
  const writing = new Set<Promise<unknown>>();
  worker.on("failed", (job, error) => {
    if (!isFinalFailure(job) || worker.name === deadLetters.name) return;
    const record: DeadLetter = {
      queue: worker.name,
      jobId: job.id,
      name: job.name,
      data: job.data,
      attemptsMade: job.attemptsMade,
      failedReason: error.message,
      stack: error.stack,
      failedAt: new Date(job.finishedOn).toISOString(),
    };
    const write = deadLetters
      .add("failed", record, {
        attempts: 1,
        removeOnComplete: JOB_RETENTION.removeOnFail,
        removeOnFail: JOB_RETENTION.removeOnFail,
      })
      .catch((cause: unknown) =>
        // The data stays out of this message: the failed job keeps it, for the retention above.
        options.onError(
          new Error(`Could not record the final failure of ${worker.name} job ${job.id}`, {
            cause,
          }),
        ),
      );
    writing.add(write);
    void write.finally(() => writing.delete(write));
  });
  return async () => {
    await Promise.all(writing);
  };
}

/** The reason BullMQ writes when it gives up on a job whose worker kept dying. */
const STALLED_OUT = "job stalled more than allowable limit";

/**
 * For a `failed` listener: true when BullMQ failed `job` for good because its worker kept dying,
 * not because the job threw. A row the job was driving then needs "the worker was lost" rather
 * than "the job failed", and BullMQ never calls the processor again to write it.
 *
 * It matches BullMQ's reason exactly, as `retryStalledFailures` does, so a job whose own error
 * mentions "stalled" is not one.
 */
export function isStalledOut(job: Job | undefined): job is Job & { finishedOn: number } {
  return isFinalFailure(job) && job.failedReason === STALLED_OUT;
}

/**
 * Re-adds the failed jobs that failed because their worker died, and returns how many. Call it
 * when a worker starts, because a worker starting is what stranded them: two deploys inside one
 * long job use up its two stall retries, and BullMQ then fails it for good.
 *
 * It matches BullMQ's reason exactly, so a job that failed on its own, even with "stalled" in its
 * error, stays failed. Never call it on a queue whose jobs must run at most once.
 *
 * A job that leaves the failed set while this runs is skipped, not an error: something removed
 * it, or a second process starting at the same time retried it first. Stopping there would leave
 * every job after it failed.
 */
export async function retryStalledFailures(
  queue: Queue,
  options: { limit?: number } = {},
): Promise<number> {
  const { limit = 200 } = options;
  if (!(Number.isInteger(limit) && limit > 0))
    throw new TypeError(`limit is a whole number above 0, not ${limit}`);
  let retried = 0;
  for (const job of await queue.getFailed(0, limit - 1)) {
    if (!isStalledOut(job)) continue;
    try {
      await job.retry();
    } catch (error) {
      // Ask Redis where the job is rather than read BullMQ's error text, which is not an API.
      if ((await queue.getJobState(job.id ?? "")) !== "failed") continue;
      throw error;
    }
    retried++;
  }
  return retried;
}

/** Every so many milliseconds, or at a cron pattern in a named time zone. */
export type JobSchedule = { every: number } | { pattern: string; tz: string };

/**
 * Makes `queue`'s job schedulers match `schedules`, one per entry, and removes every other
 * scheduler on the queue, so a renamed or deleted entry stops firing. A run of it that was already
 * due when you removed it still runs, once. Safe on every boot. Give the table a queue of its own,
 * since anything else scheduled on it is removed.
 *
 *     await syncJobSchedulers(maintenance, {
 *       "session-prune": { pattern: "20 4 * * *", tz: "UTC" },
 *       "job-reaper": { every: 2 * 60_000 },
 *     });
 *
 * Each job is named after its entry, and carries `{ name }` as its data.
 */
export async function syncJobSchedulers(
  queue: Queue,
  schedules: Readonly<Record<string, JobSchedule>>,
  options: { idPrefix?: string } = {},
): Promise<{ upserted: string[]; removed: string[] }> {
  const { idPrefix = "" } = options;
  const entries = Object.entries(schedules);
  const ids = new Set(entries.map(([name]) => idPrefix + name));
  const removed: string[] = [];
  // An entry whose record is gone comes back as null, with no id to remove it by. Nothing runs it.
  for (const scheduler of await queue.getJobSchedulers()) {
    if (!scheduler || ids.has(scheduler.key)) continue;
    await queue.removeJobScheduler(scheduler.key);
    removed.push(scheduler.key);
  }
  for (const [name, schedule] of entries)
    await queue.upsertJobScheduler(idPrefix + name, schedule, {
      name,
      data: { name },
      opts: JOB_RETENTION,
    });
  return { upserted: entries.map(([name]) => idPrefix + name), removed };
}
