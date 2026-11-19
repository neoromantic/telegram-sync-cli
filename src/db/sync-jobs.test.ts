import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createChatSyncStateService } from "./chat-sync-state";
import { createSyncJobsService, type SyncJobsService } from "./sync-jobs";
import { SyncJobStatus, SyncJobType, SyncPriority } from "./sync-schema";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

describe("SyncJobsService", () => {
  let db: Database;
  let service: SyncJobsService;

  beforeEach(() => {
    db = createAccountCacheDb();
    service = createSyncJobsService(db);
  });

  afterEach(() => {
    setSystemTime();
  });

  function waitUntil(id: number, runAt: number) {
    db.run("UPDATE sync_jobs SET next_run_at = ? WHERE id = ?", [runAt, id]);
  }

  function enableChat(chatId: number, enabled = true) {
    createChatSyncStateService(db).upsert({
      chat_id: chatId,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: enabled,
    });
  }

  function create(chatId: number, jobType: SyncJobType, priority: SyncPriority) {
    return service.create({ chat_id: chatId, job_type: jobType, priority });
  }

  it("creates a pending job, due at once, with no attempts", () => {
    expect(create(100, SyncJobType.ForwardCatchup, SyncPriority.Realtime)).toMatchObject({
      chat_id: 100,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.Realtime,
      status: SyncJobStatus.Pending,
      attempts: 0,
      next_run_at: 0,
    });
  });

  it("gives the due pending job of the types: highest priority, then oldest", () => {
    const now = 1_700_000_000_000;
    const lane = [SyncJobType.BackwardHistory, SyncJobType.FullSync];
    const next = () => service.getNextPendingOfTypes(lane);
    setSystemTime(now);
    const medium = create(1, SyncJobType.BackwardHistory, SyncPriority.Medium);
    const high = create(2, SyncJobType.FullSync, SyncPriority.High);
    const catchup = create(3, SyncJobType.ForwardCatchup, SyncPriority.Realtime);
    setSystemTime(now - 1_000);
    const older = create(4, SyncJobType.BackwardHistory, SyncPriority.High);
    const waiting = create(5, SyncJobType.BackwardHistory, SyncPriority.Realtime);
    waitUntil(waiting.id, now + 60_000);
    setSystemTime(now);

    const order: number[] = [];
    for (let job = next(); job; job = next()) {
      order.push(job.id);
      service.markRunning(job.id);
    }
    expect(order).toEqual([older.id, high.id, medium.id]);
    expect(service.getPendingJobs().map((job) => job.id)).toEqual([waiting.id, catchup.id]);

    setSystemTime(now + 60_000);
    expect(next()?.id).toBe(waiting.id);
  });

  it("runs a pending job once and completes a running one once", () => {
    setSystemTime(1_700_000_000_000);
    const job = create(100, SyncJobType.ForwardCatchup, SyncPriority.High);

    expect(service.markCompleted(job.id)).toBe(false);
    expect(service.markRunning(job.id)).toBe(true);
    expect(service.markRunning(job.id)).toBe(false);
    expect(service.getById(job.id)).toMatchObject({
      status: SyncJobStatus.Running,
      started_at: 1_700_000_000_000,
    });

    setSystemTime(1_700_000_001_000);
    expect(service.markCompleted(job.id)).toBe(true);
    expect(service.markCompleted(job.id)).toBe(false);
    expect(service.getById(job.id)).toMatchObject({
      status: SyncJobStatus.Completed,
      completed_at: 1_700_000_001_000,
    });
  });

  describe("failOrDrop", () => {
    function runningJob(chatId = 100) {
      const job = service.create({
        chat_id: chatId,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      });
      service.markRunning(job.id);
      return job;
    }

    it("marks the job failed and counts the attempt", () => {
      enableChat(100);
      const job = runningJob();

      expect(service.failOrDrop(job.id, "CHANNEL_PRIVATE")).toBe("failed");

      expect(service.getById(job.id)).toMatchObject({
        status: SyncJobStatus.Failed,
        attempts: 1,
        error_message: "CHANNEL_PRIVATE",
        completed_at: expect.any(Number),
      });
    });

    it("deletes the job of a chat that was turned off while it ran", () => {
      enableChat(100, false);
      const off = runningJob(100);
      const unknown = runningJob(200);

      for (const job of [off, unknown]) {
        expect(service.failOrDrop(job.id, "CHANNEL_PRIVATE")).toBe("cancelled");
        expect(service.getById(job.id)).toBeNull();
      }
      expect(service.countJobs().failed).toBe(0);
    });

    it("changes nothing for a job that is not running", () => {
      enableChat(100);
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      });

      expect(service.failOrDrop(job.id, "CHANNEL_PRIVATE")).toBe("not_running");
      expect(service.getById(job.id)).toEqual(job);
    });
  });

  describe("retryLater", () => {
    const now = 1_700_000_000_000;

    function runningJob(chatId = 100) {
      const job = service.create({
        chat_id: chatId,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      });
      service.markRunning(job.id);
      return job;
    }

    it("makes the job pending again and counts the attempt", () => {
      setSystemTime(now);
      enableChat(100);
      const job = runningJob();

      expect(
        service.retryLater(job.id, {
          error: "connection reset",
          runAt: now + 60_000,
          countAttempt: true,
        }),
      ).toBe("retrying");

      expect(service.getById(job.id)).toEqual({
        ...job,
        status: SyncJobStatus.Pending,
        attempts: 1,
        next_run_at: now + 60_000,
        error_message: "connection reset",
        started_at: null,
      });
    });

    it("takes the chat's priority now, after a mode change while it ran", () => {
      createChatSyncStateService(db).upsert({
        chat_id: -1001234567890,
        chat_type: "supergroup",
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      });
      const job = service.create({
        chat_id: -1001234567890,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      });
      service.markRunning(job.id);

      createChatSyncStateService(db).setSyncMode(-1001234567890, "on");
      service.retryLater(job.id, {
        error: "connection reset",
        runAt: now,
        countAttempt: true,
      });

      expect(service.getById(job.id)).toMatchObject({
        status: SyncJobStatus.Pending,
        priority: SyncPriority.Realtime,
      });
    });

    it("keeps the attempts for a FLOOD_WAIT", () => {
      enableChat(100);
      const job = runningJob();

      service.retryLater(job.id, {
        error: "Rate limited: wait 600s",
        runAt: now + 600_000,
        countAttempt: false,
      });

      expect(service.getById(job.id)).toMatchObject({
        status: SyncJobStatus.Pending,
        attempts: 0,
        next_run_at: now + 600_000,
      });
    });

    it("deletes the job of a chat that was turned off while it ran", () => {
      enableChat(100, false);
      const off = runningJob(100);
      const unknown = runningJob(200);

      for (const job of [off, unknown]) {
        expect(
          service.retryLater(job.id, {
            error: "connection reset",
            runAt: now,
            countAttempt: true,
          }),
        ).toBe("cancelled");
        expect(service.getById(job.id)).toBeNull();
      }
    });

    it("changes nothing for a job that is not running", () => {
      enableChat(100);
      const job = service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Medium,
      });

      expect(
        service.retryLater(job.id, {
          error: "connection reset",
          runAt: now,
          countAttempt: true,
        }),
      ).toBe("not_running");
      expect(service.getById(job.id)).toEqual(job);
    });
  });

  it("records a job's cursors and adds up the messages it fetched", () => {
    const job = create(100, SyncJobType.BackwardHistory, SyncPriority.Background);
    service.markRunning(job.id);

    service.updateProgress(job.id, { cursor_start: 1000, cursor_end: 500, messages_fetched: 50 });
    service.updateProgress(job.id, { cursor_end: 400, messages_fetched: 30 });

    expect(service.getById(job.id)).toMatchObject({
      cursor_start: 1000,
      cursor_end: 400,
      messages_fetched: 80,
    });
  });

  describe("getJobsForChat", () => {
    it("returns all jobs for a specific chat", () => {
      service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      });
      service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      });
      service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      });

      const jobs = service.getJobsForChat(100);
      expect(jobs).toHaveLength(2);
      expect(jobs.every((j) => j.chat_id === 100)).toBe(true);
    });
  });

  it("holds a chat's slot for a job type while its job is pending, running or failed", () => {
    const active = () => service.hasActiveJobForChat(100, SyncJobType.ForwardCatchup);
    const job = create(100, SyncJobType.ForwardCatchup, SyncPriority.High);
    expect(active()).toBe(true);
    expect(service.hasActiveJobForChat(100, SyncJobType.BackwardHistory)).toBe(false);

    service.markRunning(job.id);
    expect(active()).toBe(true);
    service.markFailed(job.id, "Network error");
    expect(active()).toBe(true);
    service.deleteFailed();
    expect(active()).toBe(false);

    const done = create(100, SyncJobType.ForwardCatchup, SyncPriority.High);
    service.markRunning(done.id);
    service.markCompleted(done.id);
    expect(active()).toBe(false);
  });

  it("deletes the failed jobs of one chat or of all, even one that failed just now", () => {
    function failedJob(chatId: number) {
      const job = create(chatId, SyncJobType.ForwardCatchup, SyncPriority.High);
      service.markRunning(job.id);
      service.markFailed(job.id, "Network error");
      return job;
    }
    setSystemTime(1_700_000_000_000);
    failedJob(100);
    failedJob(100);
    const other = failedJob(200);
    const pending = create(300, SyncJobType.ForwardCatchup, SyncPriority.High);

    expect(service.deleteFailed(100)).toBe(2);
    expect(service.getFailedJobs(10).map((job) => job.id)).toEqual([other.id]);
    expect(service.deleteFailed()).toBe(1);
    expect(service.getFailedJobs(10)).toEqual([]);
    expect(service.getById(pending.id)).not.toBeNull();
  });

  describe("getFailedJobs", () => {
    it("returns the newest failed jobs first", () => {
      const ids: number[] = [];
      for (const [i, chatId] of [100, 200, 300].entries()) {
        setSystemTime(1_700_000_000_000 + i * 1000);
        const job = service.create({
          chat_id: chatId,
          job_type: SyncJobType.ForwardCatchup,
          priority: SyncPriority.High,
        });
        service.markRunning(job.id);
        service.markFailed(job.id, `error ${chatId}`);
        ids.push(job.id);
      }

      expect(service.getFailedJobs(2).map((job) => job.id)).toEqual(ids.slice(1).reverse());
    });
  });

  describe("countJobs", () => {
    it("counts jobs by status, and pending jobs that failed before", () => {
      enableChat(100);
      const create = () =>
        service.create({
          chat_id: 100,
          job_type: SyncJobType.BackwardHistory,
          priority: SyncPriority.High,
        });

      expect(service.countJobs()).toEqual({
        pending: 0,
        running: 0,
        failed: 0,
        retrying: 0,
      });

      create();
      service.markRunning(create().id);
      const failed = create();
      service.markRunning(failed.id);
      service.markFailed(failed.id, "Network error");
      const retrying = create();
      service.markRunning(retrying.id);
      service.retryLater(retrying.id, {
        error: "Network error",
        runAt: Date.now() + 60_000,
        countAttempt: true,
      });
      const deferred = create();
      service.markRunning(deferred.id);
      service.retryLater(deferred.id, {
        error: "Rate limited: wait 30s",
        runAt: Date.now() + 30_000,
        countAttempt: false,
      });

      expect(service.countJobs()).toEqual({
        pending: 3,
        running: 1,
        failed: 1,
        retrying: 1,
      });
    });
  });

  describe("cancelPendingForChat", () => {
    it("cancels all pending jobs for a chat", () => {
      const job1 = service.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      });
      const job2 = service.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Low,
      });
      const job3 = service.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      });

      service.markRunning(job1.id);

      const cancelled = service.cancelPendingForChat(100);

      expect(cancelled).toBe(1);
      expect(service.getById(job1.id)?.status).toBe(SyncJobStatus.Running);
      expect(service.getById(job2.id)).toBeNull();
      expect(service.getById(job3.id)).not.toBeNull();
    });
  });

  it("makes the jobs a crashed daemon left running pending again", () => {
    const running = [
      create(100, SyncJobType.ForwardCatchup, SyncPriority.High),
      create(200, SyncJobType.BackwardHistory, SyncPriority.Background),
    ];
    const pending = create(300, SyncJobType.InitialLoad, SyncPriority.Medium);
    for (const job of running) service.markRunning(job.id);

    expect(service.recoverCrashedJobs()).toBe(2);

    for (const job of running) {
      expect(service.getById(job.id)).toMatchObject({
        status: SyncJobStatus.Pending,
        error_message: "Daemon crashed during execution",
      });
    }
    expect(service.getById(pending.id)).toEqual(pending);
  });
});
