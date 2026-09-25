import { once } from "node:events";
import { Queue, UnrecoverableError, type Job } from "bullmq";
import type IORedis from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { hasRedisServer, startRedisServer } from "../__tests__/redis-server.ts";
import { createRedis } from "../redis/index.ts";
import {
  CAPPED_EXPONENTIAL,
  JOB_RETENTION,
  cappedBackoff,
  createQueue,
  createWorker,
  isFinalFailure,
  isStalledOut,
  removeLeftoverJob,
  retryStalledFailures,
  syncJobSchedulers,
  wireDeadLetter,
  type DeadLetter,
  type JobSchedule,
} from "./index.ts";

describe("cappedBackoff", () => {
  it("doubles from 5 s up to 120 s, and waits between half and all of each step", () => {
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      expect([1, 2, 3, 4, 5, 6, 20].map((n) => cappedBackoff(n, CAPPED_EXPONENTIAL))).toEqual([
        2_500, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
      ]);
      random.mockReturnValue(0.999_999);
      expect(cappedBackoff(1, CAPPED_EXPONENTIAL)).toBe(4_999);
      expect(cappedBackoff(20, CAPPED_EXPONENTIAL)).toBe(119_999);
    } finally {
      random.mockRestore();
    }
  });

  it("refuses a type nobody registered, and names the ones that exist", () => {
    expect(() => cappedBackoff(1, "exponental")).toThrow(
      'The backoff type "exponental" is not registered on this worker. Use "capped-exponential"',
    );
  });
});

describe("syncJobSchedulers' table", () => {
  it("will not take a cron pattern without its time zone", () => {
    const table: Record<string, JobSchedule> = {
      // @ts-expect-error without a time zone the pattern runs on the box's clock
      nightly: { pattern: "0 4 * * *" },
    };
    expect(table).toHaveProperty("nightly");
  });
});

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(check: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`still false after ${ms} ms`);
    await settle(20);
  }
}

describe.skipIf(!hasRedisServer)("against a real Redis", () => {
  let server: Awaited<ReturnType<typeof startRedisServer>>;
  let redis: IORedis;
  const errors: Error[] = [];
  const open: { close(): Promise<unknown> }[] = [];
  let prefixes = 0;

  /** The options every queue and worker in one test shares: one connection, one key prefix. */
  const on = () => ({
    connection: redis,
    prefix: `t${++prefixes}`,
    onError: (error: Error) => void errors.push(error),
  });
  const track = <T extends { close(): Promise<unknown> }>(closable: T): T => {
    open.push(closable);
    return closable;
  };

  beforeAll(async () => {
    server = await startRedisServer();
    redis = createRedis({ url: server.url, onError: (error) => void errors.push(error) });
  });

  afterEach(async () => {
    for (const closable of open.splice(0).reverse()) await closable.close();
    expect(errors.splice(0)).toEqual([]);
  });

  afterAll(async () => {
    await redis.quit();
    server.stop();
  });

  describe("createQueue and createWorker", () => {
    it("keep finished jobs for JOB_RETENTION, and let a caller's options win", () => {
      const at = on();
      const queue = track(createQueue("q", at));
      expect(queue.defaultJobOptions).toEqual(JOB_RETENTION);
      expect(queue.listeners("error")).toEqual([at.onError]);
      expect(
        track(createQueue("q", { ...at, defaultJobOptions: { attempts: 3 } })).defaultJobOptions,
      ).toEqual({ ...JOB_RETENTION, attempts: 3 });

      const worker = track(createWorker("q", async () => {}, { ...at, autorun: false }));
      expect(worker.opts).toMatchObject({
        ...JOB_RETENTION,
        stalledInterval: 30_000,
        maxStalledCount: 2,
        metrics: { maxDataPoints: 20_160 },
        settings: { backoffStrategy: cappedBackoff },
        prefix: at.prefix,
      });
      expect(worker.listeners("error")).toEqual([at.onError]);
      const atMostOnce = track(
        createWorker("q", async () => {}, { ...at, autorun: false, maxStalledCount: 0 }),
      );
      expect(atMostOnce.opts.maxStalledCount).toBe(0);
    });

    it("trims a job a script added through a bare Queue, by the worker's retention", async () => {
      const at = on();
      const script = track(new Queue("q", { connection: redis, prefix: at.prefix }));
      const worker = track(
        createWorker("q", async () => {}, { ...at, removeOnComplete: { count: 0 } }),
      );
      const completed = once(worker, "completed");
      const job = await script.add("backfill", {});
      await completed;
      await eventually(async () => (await script.getJob(job.id ?? "")) === undefined);
    });

    it("run the capped backoff when a job asks for it", async () => {
      const at = on();
      const queue = track(createQueue("q", at));
      const worker = track(
        createWorker(
          "q",
          async () => {
            throw new Error("the provider is down");
          },
          at,
        ),
      );
      const failed = once(worker, "failed");
      const job = await queue.add(
        "call",
        {},
        { attempts: 3, backoff: { type: CAPPED_EXPONENTIAL } },
      );
      await failed;
      const retrying = await queue.getJob(job.id ?? "");
      expect(await retrying?.getState()).toBe("delayed");
      expect(retrying?.delay).toBeGreaterThanOrEqual(2_500);
      expect(retrying?.delay).toBeLessThan(5_000);
    });
  });

  describe("wireDeadLetter", () => {
    it("records each job once it has failed for good, and none that will run again", async () => {
      const at = on();
      const queue = track(createQueue("work", at));
      const deadLetters = track(createQueue<DeadLetter>("dead-letters", at));
      const worker = track(
        createWorker(
          "work",
          async (job) => {
            if (job.name === "account-gone") throw new UnrecoverableError("the account is gone");
            throw new Error(`${job.name} failed`);
          },
          // A strategy that answers -1 ends the job on its first failure.
          { ...at, settings: { backoffStrategy: () => -1 } },
        ),
      );
      const flush = wireDeadLetter(worker, deadLetters, at);
      const seen: string[] = [];
      worker.on("failed", (job) => void seen.push(`${job?.name} ${isFinalFailure(job)}`));

      await queue.add("flaky", { id: 1 }, { attempts: 2, backoff: { type: "fixed", delay: 10 } });
      await queue.add("account-gone", { id: 2 }, { attempts: 3 });
      await queue.add("gave-up", { id: 3 }, { attempts: 3, backoff: { type: "custom" } });
      await eventually(() => seen.length === 4);
      await flush();

      expect(seen.sort()).toEqual([
        "account-gone true",
        "flaky false",
        "flaky true",
        "gave-up true",
      ]);
      const records = (await deadLetters.getWaiting()).map((job) => job.data);
      expect(records.map((record) => record.name).sort()).toEqual([
        "account-gone",
        "flaky",
        "gave-up",
      ]);
      expect(records.find((record) => record.name === "account-gone")).toEqual({
        queue: "work",
        jobId: expect.any(String),
        name: "account-gone",
        data: { id: 2 },
        attemptsMade: 1,
        failedReason: "the account is gone",
        stack: expect.stringContaining("UnrecoverableError: the account is gone"),
        failedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
    });

    it("records a job a scheduler made", async () => {
      const at = on();
      const maintenance = track(createQueue("maintenance", at));
      const deadLetters = track(createQueue<DeadLetter>("dead-letters", at));
      const worker = track(
        createWorker(
          "maintenance",
          async () => {
            throw new Error("the prune query timed out");
          },
          at,
        ),
      );
      const flush = wireDeadLetter(worker, deadLetters, at);
      const failed = once(worker, "failed");
      await syncJobSchedulers(maintenance, { "session-prune": { every: 60_000 } });
      await failed;
      await flush();

      const [record] = (await deadLetters.getWaiting()).map((job) => job.data);
      expect(record?.jobId).toMatch(/^repeat:session-prune:/);
      expect(record?.failedReason).toBe("the prune query timed out");
    });

    it("never records a dead letter's own failure", async () => {
      const at = on();
      const deadLetters = track(createQueue<DeadLetter>("dead-letters", at));
      const alerter = track(
        createWorker<DeadLetter>(
          "dead-letters",
          async () => {
            throw new Error("the alert channel is down");
          },
          at,
        ),
      );
      const flush = wireDeadLetter(alerter, deadLetters, at);
      const failed = once(alerter, "failed");
      await deadLetters.add("failed", {
        queue: "work",
        jobId: "1",
        name: "x",
        data: null,
        attemptsMade: 1,
        failedReason: "x",
        stack: undefined,
        failedAt: new Date().toISOString(),
      });
      await failed;
      await flush();
      expect([await deadLetters.getWaitingCount(), await deadLetters.getFailedCount()]).toEqual([
        0, 1,
      ]);
    });

    it("reports a record it could not write, with the job's data left out", async () => {
      const at = on();
      const queue = track(createQueue("work", at));
      const lost = createRedis({ url: server.url, onError: () => {} });
      const deadLetters = createQueue<DeadLetter>("dead-letters", {
        ...at,
        connection: lost,
        onError: () => {},
      });
      await deadLetters.waitUntilReady();
      lost.disconnect();
      const worker = track(
        createWorker(
          "work",
          async () => {
            throw new UnrecoverableError("no");
          },
          at,
        ),
      );
      const reported: Error[] = [];
      const flush = wireDeadLetter(worker, deadLetters, { onError: (e) => void reported.push(e) });
      const failed = once(worker, "failed");
      const job = await queue.add("send", { token: "secret-value" });
      await failed;
      await flush();

      expect(reported).toHaveLength(1);
      expect(reported[0]?.message).toBe(`Could not record the final failure of work job ${job.id}`);
      expect(JSON.stringify(reported[0])).not.toContain("secret-value");
      await deadLetters.close();
    });
  });

  describe("isStalledOut and retryStalledFailures", () => {
    it("tells a job whose worker died from one that failed on its own, and re-runs only the first", async () => {
      const at = on();
      const queue = track(createQueue("long", at));
      const settings = { lockDuration: 500, stalledInterval: 200, maxStalledCount: 0 };
      // A worker that takes a job and dies without letting go of it, as a killed process does.
      const dying = createWorker("long", () => new Promise(() => {}), { ...at, ...settings });
      const taken = once(dying, "active");
      const stranded = await queue.add("export", {});
      await taken;
      await dying.close(true);

      const ran: string[] = [];
      const worker = track(
        createWorker(
          "long",
          async (job) => {
            ran.push(job.name);
            if (job.name === "sync") throw new Error("the upstream stalled");
          },
          { ...at, ...settings },
        ),
      );
      const seen: string[] = [];
      worker.on("failed", (job) => void seen.push(`${job?.name} ${isStalledOut(job)}`));
      await queue.add("sync", {});
      await eventually(async () => (await queue.getFailedCount()) === 2, 10_000);
      expect((await queue.getJob(stranded.id ?? ""))?.failedReason).toBe(
        "job stalled more than allowable limit",
      );
      // What a `failed` listener sees: only the job whose worker died was stalled out.
      await eventually(async () => seen.length === 2);
      expect(seen.sort()).toEqual(["export true", "sync false"]);

      expect(await retryStalledFailures(queue)).toBe(1);
      await eventually(async () => (await queue.getCompletedCount()) === 1);
      expect(ran).toEqual(["sync", "export"]);
      expect((await queue.getFailed()).map((job) => job.name)).toEqual(["sync"]);
    }, 15_000);

    it("refuses a limit that is not a whole number above 0", async () => {
      const queue = track(createQueue("long", on()));
      for (const limit of [0, -1, 1.5])
        await expect(retryStalledFailures(queue, { limit })).rejects.toThrow(
          "limit is a whole number above 0",
        );
    });
  });

  describe("removeLeftoverJob", () => {
    it("clears a finished job from its id, so the next add under that id runs", async () => {
      const at = on();
      const queue = track(createQueue("q", at));
      const ran: unknown[] = [];
      const worker = track(createWorker("q", async (job) => void ran.push(job.data), at));
      const jobId = "refetch-42";

      let completed = once(worker, "completed");
      await queue.add("refetch", { run: 1 }, { jobId });
      await completed;
      await queue.add("refetch", { run: 2 }, { jobId });
      await settle(200);
      expect(ran).toEqual([{ run: 1 }]);

      completed = once(worker, "completed");
      await removeLeftoverJob(await queue.getJob(jobId));
      await queue.add("refetch", { run: 3 }, { jobId });
      await completed;
      expect(ran).toEqual([{ run: 1 }, { run: 3 }]);
    });

    it("leaves a job that has not run yet, and takes a missing one", async () => {
      const queue = track(createQueue("q", on()));
      const waiting = await queue.add("refetch", {}, { jobId: "refetch-7", delay: 60_000 });
      await removeLeftoverJob(waiting);
      expect(await (await queue.getJob("refetch-7"))?.getState()).toBe("delayed");
      await removeLeftoverJob(undefined);
    });
  });

  describe("syncJobSchedulers", () => {
    it("matches the table, removing what it no longer names, old-style repeats included", async () => {
      const at = on();
      const queue = track(createQueue("maintenance", at));
      await queue.upsertJobScheduler("renamed-away", { pattern: "0 3 * * *", tz: "UTC" });
      // Its first run is due at once, so it is waiting rather than delayed.
      await queue.upsertJobScheduler("due-now", { every: 60_000 });
      await queue.add("before-schedulers", {}, { repeat: { every: 60_000 } });
      // A scheduler whose record is gone: BullMQ lists it as null.
      await redis.zadd(`${at.prefix}:maintenance:repeat`, Date.now() + 60_000, "ghost");
      const table = {
        "session-prune": { pattern: "20 4 * * *", tz: "America/Sao_Paulo" },
        "job-reaper": { every: 120_000 },
      };

      const first = await syncJobSchedulers(queue, table);
      expect(first.upserted).toEqual(["session-prune", "job-reaper"]);
      expect(first.removed).toHaveLength(3);
      expect(first.removed).toEqual(expect.arrayContaining(["renamed-away", "due-now"]));

      const schedulers = (await queue.getJobSchedulers()).filter(Boolean);
      expect(
        schedulers.map(({ key, pattern, tz, every }) => ({ key, pattern, tz, every })),
      ).toEqual(
        expect.arrayContaining([
          {
            key: "session-prune",
            pattern: "20 4 * * *",
            tz: "America/Sao_Paulo",
            every: undefined,
          },
          { key: "job-reaper", pattern: undefined, tz: undefined, every: 120_000 },
        ]),
      );
      expect(schedulers).toHaveLength(2);
      // A removed scheduler's next run goes with it; a run that was already due still runs once.
      const jobs = await queue.getJobs(["delayed", "waiting"]);
      expect(jobs.map((job) => job.name).sort()).toEqual([
        "due-now",
        "job-reaper",
        "session-prune",
      ]);
      const scheduled = jobs.filter((job) => job.name !== "due-now");
      expect(scheduled.map((job) => job.data)).toContainEqual({ name: "session-prune" });
      for (const job of scheduled) expect(job.opts).toMatchObject(JOB_RETENTION);

      expect(await syncJobSchedulers(queue, table)).toEqual({
        upserted: ["session-prune", "job-reaper"],
        removed: [],
      });
      expect((await queue.getJobs(["delayed", "waiting"])).length).toBe(3);
    });

    it("keeps ids under a prefix, and names each job after its entry", async () => {
      // A bare Queue, so the retention below comes from the schedule and not the queue.
      const queue = track(new Queue("maintenance", { connection: redis, prefix: on().prefix }));
      await syncJobSchedulers(queue, { "job-reaper": { every: 120_000 } }, { idPrefix: "maint-" });
      expect((await queue.getJobSchedulers()).map((scheduler) => scheduler.key)).toEqual([
        "maint-job-reaper",
      ]);
      const [job] = await queue.getJobs(["delayed", "waiting"]);
      expect(job?.name).toBe("job-reaper");
      expect(job?.opts).toMatchObject(JOB_RETENTION);
    });
  });

  // The README's snippet. Kept here, beside the Redis it needs.
  it("README — background jobs", async () => {
    const prefix = on().prefix;
    const logger = { error: (_message: string, _meta: { error: Error }) => {} };
    const built: string[] = [];
    const buildReport = async (job: Job<{ userId: string }>) => {
      if (job.data.userId === "") throw new UnrecoverableError("no user");
      built.push(job.data.userId);
    };

    const onError = (error: Error) => logger.error("[bullmq] connection error", { error });
    const reports = track(
      createQueue<{ userId: string }>("reports", { connection: redis, onError, prefix }),
    );
    const deadLetters = track(
      createQueue<DeadLetter>("dead-letters", { connection: redis, onError, prefix }),
    );

    const worker = track(
      createWorker<{ userId: string }>("reports", buildReport, {
        connection: redis,
        onError,
        concurrency: 5,
        prefix,
      }),
    );
    const flush = wireDeadLetter(worker, deadLetters, { onError });
    await retryStalledFailures(reports);

    const failed = once(worker, "failed");
    await reports.add("monthly", { userId: "" });
    await reports.add("monthly", { userId: "u1" });
    await failed;
    await eventually(() => built.length === 1);
    await flush();
    expect(await deadLetters.getWaitingCount()).toBe(1);

    const maintenance = track(createQueue("maintenance", { connection: redis, onError, prefix }));
    await syncJobSchedulers(maintenance, {
      "session-prune": { pattern: "20 4 * * *", tz: "UTC" },
      "job-reaper": { every: 2 * 60_000 },
    });
    expect(await maintenance.getJobSchedulersCount()).toBe(2);
  });
});
