import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { createSyncScheduler, type SyncScheduler } from "./scheduler";
import { pruneCache } from "../db/cache-maintenance";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createMessagesCache } from "../db/messages-cache";
import { createSyncJobsService } from "../db/sync-jobs";
import { SyncJobStatus, SyncJobType, SyncPriority } from "../db/sync-schema";
import { getDefaultRetentionConfig } from "../db/types";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { takePartIn } from "../test/participation.test-utils";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("SyncScheduler", () => {
  let db: Database;
  let scheduler: SyncScheduler;
  let jobsService: ReturnType<typeof createSyncJobsService>;
  let chatSyncState: ReturnType<typeof createChatSyncStateService>;
  let messagesCache: ReturnType<typeof createMessagesCache>;

  afterEach(() => {
    setSystemTime();
  });

  function failJob(id: number, error = "CHANNEL_PRIVATE") {
    jobsService.markRunning(id);
    jobsService.markFailed(id, error);
  }

  beforeEach(() => {
    db = createAccountCacheDb();
    takePartIn(db, -4001, -4002, -1001234567890);
    jobsService = createSyncJobsService(db);
    chatSyncState = createChatSyncStateService(db);
    messagesCache = createMessagesCache(db);
    scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    });
  });

  describe("queue methods", () => {
    it("create no job for a disabled chat or a chat without sync state", () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: "channel",
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
        forward_cursor: 10,
        backward_cursor: 5,
      });

      for (const chatId of [100, 999]) {
        scheduler.queueForwardCatchup(chatId);
        scheduler.queueInitialLoad(chatId);
        scheduler.queueBackwardHistory(chatId);
      }

      expect(jobsService.getJobsForChat(100)).toHaveLength(0);
      expect(jobsService.getJobsForChat(999)).toHaveLength(0);
    });

    it("give each job its chat tier as priority", () => {
      chatSyncState.upsert({
        chat_id: -4001,
        chat_type: "group",
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        forward_cursor: 10,
        backward_cursor: 5,
      });
      chatSyncState.upsert({
        chat_id: -4002,
        chat_type: "group",
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      });

      scheduler.queueForwardCatchup(-4001);
      scheduler.queueBackwardHistory(-4001);
      scheduler.queueInitialLoad(-4002);

      const priorities = jobsService.getPendingJobs().map((job) => job.priority);
      expect(priorities).toEqual([SyncPriority.Medium, SyncPriority.Medium, SyncPriority.Medium]);
    });
  });

  describe("a chat turned on with tg chats sync", () => {
    beforeEach(() => {
      chatSyncState.upsert({
        chat_id: -1001234567890,
        chat_type: "channel",
        member_count: 5000,
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
      });
      chatSyncState.setSyncMode(-1001234567890, "on");
    });

    it("gets its first page at P0 and its history at its tier", () => {
      scheduler.refreshQueues();
      chatSyncState.recordFirstPage(-1001234567890, {
        forward_cursor: 900,
        backward_cursor: 801,
        history_complete: false,
        new_messages: 100,
      });
      scheduler.queueBackwardHistory(-1001234567890);

      const jobs = jobsService
        .getJobsForChat(-1001234567890)
        .map((job) => [job.job_type, job.priority])
        .sort();
      expect(jobs).toEqual([
        [SyncJobType.BackwardHistory, SyncPriority.High],
        [SyncJobType.InitialLoad, SyncPriority.Realtime],
      ]);
    });
  });

  describe("a bot or a deleted account (#131)", () => {
    const BOT = 7001;
    const DELETED = 7002;

    beforeEach(() => {
      for (const [chatId, reason] of [
        [BOT, "bot"],
        [DELETED, "deleted_account"],
      ] as const) {
        chatSyncState.upsert({
          chat_id: chatId,
          chat_type: "private",
          sync_priority: SyncPriority.Medium,
          sync_enabled: true,
          sync_policy: reason,
        });
      }
    });

    it("gets its first page at the medium tier and catch-up, but no history", () => {
      scheduler.refreshQueues();
      expect(jobsService.getPendingJobs().map((job) => [job.chat_id, job.job_type])).toEqual([
        [BOT, SyncJobType.InitialLoad],
        [DELETED, SyncJobType.InitialLoad],
      ]);
      expect(jobsService.getPendingJobs()[0]!.priority).toBe(SyncPriority.Medium);

      for (const chatId of [BOT, DELETED]) {
        chatSyncState.recordFirstPage(chatId, {
          forward_cursor: 900,
          backward_cursor: 801,
          history_complete: false,
          new_messages: 100,
        });
        chatSyncState.raiseTopMessageId(chatId, 950);
        scheduler.queueBackwardHistory(chatId);
      }
      scheduler.refreshQueues();

      const queued = jobsService
        .getPendingJobs()
        .filter((job) => job.job_type !== SyncJobType.InitialLoad)
        .map((job) => [job.chat_id, job.job_type]);
      expect(queued).toEqual([
        [BOT, SyncJobType.ForwardCatchup],
        [DELETED, SyncJobType.ForwardCatchup],
      ]);
    });

    it("gets its history once turned on by hand, and loses it again on --auto", () => {
      chatSyncState.recordFirstPage(BOT, {
        forward_cursor: 900,
        backward_cursor: 801,
        history_complete: false,
        new_messages: 100,
      });
      chatSyncState.raiseTopMessageId(BOT, 900);

      chatSyncState.setSyncMode(BOT, "on");
      scheduler.refreshQueues();
      expect(chatSyncState.get(BOT)).toMatchObject({
        sync_priority: SyncPriority.High,
        sync_policy: "bot",
      });
      expect(jobsService.getJobsForChat(BOT)).toMatchObject([
        { job_type: SyncJobType.BackwardHistory },
      ]);

      chatSyncState.setSyncMode(BOT, "auto");
      scheduler.refreshQueues();
      expect(chatSyncState.get(BOT)).toMatchObject({
        sync_priority: SyncPriority.Medium,
        sync_enabled: 1,
      });
      expect(jobsService.getJobsForChat(BOT)).toHaveLength(0);
    });
  });

  describe("queueBackwardHistory", () => {
    it("does not queue if history is complete", () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      });
      chatSyncState.markHistoryComplete(100);

      scheduler.queueBackwardHistory(100);

      const jobs = jobsService.getJobsForChat(100);
      expect(jobs).toHaveLength(0);
    });

    it("queues history for a chat with a forward cursor but no backward cursor (#6)", () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
      });

      scheduler.queueBackwardHistory(100);

      const jobs = jobsService.getJobsForChat(100);
      expect(jobs.map((job) => job.job_type)).toEqual([SyncJobType.BackwardHistory]);
    });

    it("queues the first page instead for a chat without a forward cursor (#6)", () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      });
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1000,
        message_type: "text",
        date: Date.now(),
        raw_json: "{}",
      });

      scheduler.queueBackwardHistory(100);

      const jobs = jobsService.getJobsForChat(100);
      expect(jobs.map((job) => job.job_type)).toEqual([SyncJobType.InitialLoad]);
    });
  });

  describe("refreshQueues", () => {
    function seed(
      chatId: number,
      options: {
        enabled?: boolean;
        cursor?: number;
        top?: number | null;
        historyComplete?: boolean;
      } = {},
    ) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: options.enabled ?? true,
        forward_cursor: options.cursor,
        backward_cursor: options.cursor === undefined ? undefined : 1,
      });
      if (options.historyComplete ?? true) {
        chatSyncState.markHistoryComplete(chatId);
      }
      if (options.top !== undefined && options.top !== null) {
        chatSyncState.raiseTopMessageId(chatId, options.top);
      }
    }

    const jobsOf = (chatId: number, jobType: SyncJobType) =>
      jobsService.getJobsForChat(chatId).filter((j) => j.job_type === jobType);

    it("queues one catch-up for each chat that is behind, none for one caught up", () => {
      seed(1, { cursor: 1000, top: 1150 });
      seed(2, { cursor: 1000, top: null });
      seed(3, { cursor: 1000, top: 1000 });

      for (let i = 0; i < 10; i++) scheduler.refreshQueues();

      expect(jobsService.getPendingJobs().map((job) => [job.chat_id, job.job_type])).toEqual([
        [1, SyncJobType.ForwardCatchup],
        [2, SyncJobType.ForwardCatchup],
      ]);
    });

    it("queues history for any enabled tier once the chat has a cursor", () => {
      seed(1, { cursor: 1000, top: 1000, historyComplete: false });
      chatSyncState.upsert({
        chat_id: -4001,
        chat_type: "group",
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        forward_cursor: 300,
        backward_cursor: 201,
      });
      chatSyncState.raiseTopMessageId(-4001, 300);
      chatSyncState.upsert({
        chat_id: -1001234567890,
        chat_type: "channel",
        sync_priority: SyncPriority.Low,
        sync_enabled: true,
        forward_cursor: 900,
        backward_cursor: 801,
      });
      chatSyncState.raiseTopMessageId(-1001234567890, 900);
      seed(2, { enabled: false, cursor: 50, top: 50, historyComplete: false });
      seed(3, { historyComplete: false });

      for (let i = 0; i < 3; i++) scheduler.refreshQueues();

      const history = jobsService
        .getPendingJobs()
        .filter((job) => job.job_type === SyncJobType.BackwardHistory)
        .map((job) => job.chat_id)
        .sort((a, b) => a - b);
      expect(history).toEqual([-1001234567890, -4001, 1]);
      expect(jobsOf(3, SyncJobType.BackwardHistory)).toHaveLength(0);
      expect(jobsOf(3, SyncJobType.InitialLoad)).toHaveLength(1);
    });

    it("queues no job of a type whose job failed, until the failed row is gone", () => {
      const t0 = 1_700_000_000_000;
      setSystemTime(t0);
      seed(1, { cursor: 1000, top: 1150 });
      seed(2, { historyComplete: false });
      seed(3, { cursor: 1000, top: 1000, historyComplete: false });
      const cases = [
        [1, SyncJobType.ForwardCatchup],
        [2, SyncJobType.InitialLoad],
        [3, SyncJobType.BackwardHistory],
      ] as const;

      scheduler.refreshQueues();
      for (const [chatId, jobType] of cases) {
        const jobs = jobsOf(chatId, jobType);
        expect(jobs).toHaveLength(1);
        failJob(jobs[0]!.id);
      }

      for (let i = 0; i < 3; i++) scheduler.refreshQueues();
      for (const [chatId, jobType] of cases) {
        expect(jobsOf(chatId, jobType).map((job) => job.status)).toEqual(["failed"]);
      }

      jobsService.deleteFailed(1);
      scheduler.refreshQueues();
      expect(jobsOf(1, SyncJobType.ForwardCatchup).map((job) => job.status)).toEqual(["pending"]);
      expect(jobsOf(2, SyncJobType.InitialLoad)).toHaveLength(1);

      setSystemTime(t0 + DAY_MS + 1);
      pruneCache(db, { ...getDefaultRetentionConfig(), failedJobs: DAY_MS }, { now: Date.now() });
      scheduler.refreshQueues();
      for (const [chatId, jobType] of cases) {
        expect(jobsOf(chatId, jobType).map((job) => job.status)).toEqual(["pending"]);
      }
    });

    it("queues one first page for an enabled chat without a cursor, whatever is cached", () => {
      seed(1);
      chatSyncState.incrementSyncedMessages(1, 3);
      messagesCache.upsert({
        chat_id: 1,
        message_id: 100,
        message_type: "text",
        date: Date.now(),
        raw_json: "{}",
      });
      seed(2, { enabled: false, historyComplete: false });

      scheduler.refreshQueues();
      scheduler.refreshQueues();

      expect(jobsOf(1, SyncJobType.InitialLoad)).toHaveLength(1);
      expect(jobsService.getJobsForChat(2)).toHaveLength(0);
    });
  });

  describe("lanes", () => {
    const laneOf = (jobType: string) =>
      jobType === SyncJobType.ForwardCatchup
        ? "catchup"
        : jobType === SyncJobType.InitialLoad
          ? "firstPage"
          : "history";

    function queue(jobType: SyncJobType, count: number, priority = 1) {
      for (let i = 0; i < count; i++) {
        jobsService.create({
          chat_id: 1000 + i,
          job_type: jobType,
          priority,
        });
      }
    }

    function run(count: number) {
      const lanes: string[] = [];
      for (let i = 0; i < count; i++) {
        const job = scheduler.getNextJob();
        if (!job) break;
        jobsService.markRunning(job.id);
        jobsService.markCompleted(job.id);
        scheduler.recordJobRun(job);
        lanes.push(laneOf(job.job_type));
      }
      return lanes;
    }

    it("take turns: catch-up, first page, catch-up, history", () => {
      queue(SyncJobType.ForwardCatchup, 10);
      queue(SyncJobType.InitialLoad, 10);
      queue(SyncJobType.BackwardHistory, 5);
      queue(SyncJobType.FullSync, 5);

      expect(run(8)).toEqual([
        "catchup",
        "firstPage",
        "catchup",
        "history",
        "catchup",
        "firstPage",
        "catchup",
        "history",
      ]);
    });

    it("give an empty lane slot to the first lane with work", () => {
      queue(SyncJobType.InitialLoad, 10);
      queue(SyncJobType.BackwardHistory, 10);
      expect(run(4)).toEqual(["firstPage", "firstPage", "firstPage", "history"]);

      jobsService.deletePendingOfType(SyncJobType.InitialLoad);
      queue(SyncJobType.ForwardCatchup, 10);
      expect(run(4)).toEqual(["catchup", "catchup", "catchup", "history"]);

      jobsService.deletePendingOfType(SyncJobType.ForwardCatchup);
      expect(run(3)).toEqual(["history", "history", "history"]);
    });

    it("give the slot of a lane whose jobs all wait for a retry to the next lane", () => {
      const now = 1_700_000_000_000;
      setSystemTime(now);
      const history = jobsService.create({
        chat_id: 2000,
        job_type: SyncJobType.BackwardHistory,
        priority: 1,
      });
      db.run("UPDATE sync_jobs SET next_run_at = ? WHERE id = ?", [now + 60_000, history.id]);
      queue(SyncJobType.InitialLoad, 1);

      for (let i = 0; i < 3; i++) scheduler.recordJobRun(history);
      expect(scheduler.getNextJob()?.job_type).toBe(SyncJobType.InitialLoad);

      setSystemTime(now + 60_000);
      expect(scheduler.getNextJob()?.id).toBe(history.id);
    });

    it("only move to the next slot when a job ran", () => {
      queue(SyncJobType.ForwardCatchup, 2);
      queue(SyncJobType.InitialLoad, 2);

      const first = scheduler.getNextJob();
      expect(scheduler.getNextJob()).toEqual(first);
      expect(first?.job_type).toBe(SyncJobType.ForwardCatchup);

      scheduler.recordJobRun(first!);
      expect(scheduler.getNextJob()?.job_type).toBe(SyncJobType.InitialLoad);
    });
  });

  describe("initializeForStartup with old pending jobs", () => {
    it("drops pending catch-ups and queues them only where due", async () => {
      for (const chatId of [1, 2]) {
        chatSyncState.upsert({
          chat_id: chatId,
          chat_type: "private",
          sync_priority: SyncPriority.High,
          sync_enabled: true,
          forward_cursor: 1000,
          backward_cursor: 1,
        });
        chatSyncState.markHistoryComplete(chatId);
        jobsService.create({
          chat_id: chatId,
          job_type: SyncJobType.ForwardCatchup,
          priority: SyncPriority.Realtime,
        });
      }
      chatSyncState.raiseTopMessageId(1, 1000);
      chatSyncState.raiseTopMessageId(2, 1150);

      await scheduler.initializeForStartup();

      expect(jobsService.getJobsForChat(1)).toHaveLength(0);
      const pending = jobsService.getPendingJobs();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        chat_id: 2,
        job_type: SyncJobType.ForwardCatchup,
      });
    });
  });

  describe("initializeForStartup with pending jobs of other chats", () => {
    it("drops jobs of disabled chats and aligns the rest to their tier", async () => {
      chatSyncState.upsert({
        chat_id: 1,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 100,
        backward_cursor: 50,
      });
      chatSyncState.raiseTopMessageId(1, 100);
      chatSyncState.upsert({
        chat_id: -4001,
        chat_type: "group",
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      });
      chatSyncState.upsert({
        chat_id: -1001234567890,
        chat_type: "channel",
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
        forward_cursor: 10,
      });
      chatSyncState.upsert({
        chat_id: -4002,
        chat_type: "group",
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      });
      chatSyncState.setSyncMode(-4002, "on");
      const history = jobsService.create({
        chat_id: 1,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      });
      const firstPage = jobsService.create({
        chat_id: -4001,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      });
      jobsService.create({
        chat_id: -1001234567890,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      });
      const turnedOn = jobsService.create({
        chat_id: -4002,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Low,
      });
      jobsService.create({
        chat_id: 777,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      });

      await scheduler.initializeForStartup();

      const pending = jobsService.getPendingJobs();
      expect(pending.map((job) => [job.id, job.chat_id, job.priority]).sort()).toEqual(
        [
          [history.id, 1, SyncPriority.High],
          [firstPage.id, -4001, SyncPriority.Medium],
          [turnedOn.id, -4002, SyncPriority.Realtime],
        ].sort(),
      );
    });
  });

  describe("initializeForStartup with failed jobs", () => {
    it("deletes every failed job and queues its chat again", async () => {
      const t0 = 1_700_000_000_000;
      setSystemTime(t0);
      chatSyncState.upsert({
        chat_id: 1,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      });
      const firstPage = jobsService.create({
        chat_id: 1,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      });
      failJob(firstPage.id);
      chatSyncState.upsert({
        chat_id: 2,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 1,
      });
      chatSyncState.markHistoryComplete(2);
      chatSyncState.raiseTopMessageId(2, 1150);
      db.run(
        `INSERT INTO sync_jobs (chat_id, job_type, priority, status, error_message, completed_at)
         VALUES (2, 'forward_catchup', 0, 'failed', 'Rate limited: wait 30s', ?)`,
        [t0 - 60_000],
      );
      chatSyncState.upsert({
        chat_id: 3,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 500,
      });
      chatSyncState.raiseTopMessageId(3, 1000);
      const history = jobsService.create({
        chat_id: 3,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.High,
      });
      db.run("UPDATE sync_jobs SET attempts = 2, next_run_at = ? WHERE id = ?", [
        t0 + 240_000,
        history.id,
      ]);

      await scheduler.initializeForStartup();

      expect(jobsService.getFailedJobs(10)).toEqual([]);
      expect(jobsService.getJobsForChat(1)).toMatchObject([
        { job_type: SyncJobType.InitialLoad, status: "pending", attempts: 0 },
      ]);
      expect(jobsService.getJobsForChat(1)[0]?.id).not.toBe(firstPage.id);
      expect(jobsService.getJobsForChat(2)).toMatchObject([
        { job_type: SyncJobType.ForwardCatchup, status: "pending" },
      ]);
      expect(jobsService.getJobsForChat(3)).toMatchObject([
        {
          id: history.id,
          status: "pending",
          attempts: 2,
          next_run_at: t0 + 240_000,
        },
      ]);
    });
  });

  describe("initializeForStartup with crashed jobs", () => {
    it("recovers crashed jobs during initialization", async () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      });

      const crashedJob = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      });
      jobsService.markRunning(crashedJob.id);

      expect(scheduler.getStatus()).toEqual({ pendingJobs: 0, runningJobs: 1 });

      await scheduler.initializeForStartup();

      expect(jobsService.getById(crashedJob.id)?.status).toBe(SyncJobStatus.Pending);
      expect(scheduler.getStatus()).toEqual({ pendingJobs: 2, runningJobs: 0 });
    });
  });
});
