import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, type mock, setSystemTime } from "bun:test";
import { type TelegramClient, tl } from "@mtcute/bun";
import { dialogToCacheInput } from "../commands/chats/helpers";
import type { DaemonContext } from "./daemon-context";
import { processJobs } from "./daemon-scheduler";
import { createSyncScheduler, type SyncScheduler } from "./scheduler";
import { createRealSyncWorker } from "./sync-worker-real";
import { pruneCache } from "../db/cache-maintenance";
import { type ChatSyncStateService, createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { createRateLimitsService } from "../db/rate-limits";
import { createSenderLookups } from "../db/sender-lookups";
import { createSyncJobsService, type SyncJobsService } from "../db/sync-jobs";
import { SyncJobType, SyncPriority } from "../db/sync-schema";
import { getDefaultRetentionConfig } from "../db/types";
import { createUsersCache } from "../db/users-cache";
import { toPeerIdFromInputPeer } from "../utils/telegram-peer-ids";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { addAccountRuntime, testDaemonContext } from "../test/daemon-runtime.test-utils";
import { fakeDialog } from "../test/fake-dialogs.test-utils";
import {
  createMultiChatHistory,
  type GetHistoryRequest,
  range,
} from "../test/fake-history.test-utils";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const FAILING_CHAT = 50_001;
const HEALTHY_CHAT = 50_002;
const PRIVATE_CHANNEL_ID = 1234567890;
const PRIVATE_CHANNEL = -1001234567890;

describe("chats whose sync pages keep failing", () => {
  let db: Database;
  let chatSyncState: ChatSyncStateService;
  let jobsService: SyncJobsService;
  let scheduler: SyncScheduler;
  let ctx: DaemonContext;
  let now: number;

  const failures = new Map<number, () => unknown>();
  let calls: Map<number, number[]>;

  beforeEach(() => {
    now = T0;
    setSystemTime(now);
    failures.clear();
    calls = new Map();

    db = createAccountCacheDb();
    chatSyncState = createChatSyncStateService(db);
    jobsService = createSyncJobsService(db);
    const messagesCache = createMessagesCache(db);
    const chatsCache = createChatsCache(db);
    const history = createMultiChatHistory();

    for (const chatId of [FAILING_CHAT, HEALTHY_CHAT]) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
        backward_cursor: 1,
      });
      chatSyncState.markHistoryComplete(chatId);
      chatSyncState.raiseTopMessageId(chatId, 1150);
      history.set(chatId, range(1, 1150));
    }

    const client = {
      call: async (request: GetHistoryRequest) => {
        const chatId = request.peer ? (toPeerIdFromInputPeer(request.peer, null) ?? 0) : 0;
        calls.set(chatId, [...(calls.get(chatId) ?? []), now]);
        const failure = failures.get(chatId);
        if (failure) throw failure();
        return history.client.call(request as never);
      },
    } as unknown as TelegramClient;

    scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    });

    ctx = testDaemonContext();
    addAccountRuntime(ctx, 1, db, {
      scheduler,
      worker: createRealSyncWorker({
        client,
        messagesCache,
        historyRanges: createHistoryRanges(db),
        chatSyncState,
        jobsService,
        rateLimits: createRateLimitsService(db),
        chatsCache,
        usersCache: createUsersCache(db),
        senderLookups: createSenderLookups(db),
      }),
    });
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: "+15550000000",
      name: null,
      status: "connected",
      client,
    });
  });

  afterEach(() => {
    setSystemTime();
    db.close();
  });

  async function runFor(ms: number) {
    const end = now + ms;
    while (now < end) {
      now += 1000;
      setSystemTime(now);
      if ((now - T0) % 30_000 === 0) scheduler.refreshQueues();
      await processJobs(ctx);
    }
  }

  async function refreshCycles(count = 100) {
    for (let i = 0; i < count; i++) {
      now += 30_000;
      setSystemTime(now);
      scheduler.refreshQueues();
      await processJobs(ctx);
    }
  }

  const callsFor = (chatId: number) => calls.get(chatId) ?? [];

  const rowsFor = (chatId: number) =>
    db
      .query(
        "SELECT id, job_type, status, attempts, error_message FROM sync_jobs WHERE chat_id = ? ORDER BY id",
      )
      .all(chatId) as Array<{
      id: number;
      job_type: string;
      status: string;
      attempts: number;
      error_message: string | null;
    }>;

  const warnings = () =>
    (ctx.logger.warn as ReturnType<typeof mock>).mock.calls.map((call) => String(call[0]));

  function expectNoDuplicateRows() {
    expect(
      db
        .query(
          `SELECT chat_id, job_type FROM sync_jobs WHERE status != 'completed'
           GROUP BY 1, 2 HAVING COUNT(*) > 1`,
        )
        .all(),
    ).toEqual([]);
  }

  it("retries a transient error after 1, 2, 4 and 8 minutes, then gives up", async () => {
    failures.set(FAILING_CHAT, () => new Error("connection reset"));
    await scheduler.initializeForStartup();

    await runFor(20 * MINUTE);

    const times = callsFor(FAILING_CHAT);
    expect(times).toHaveLength(5);
    expect(times.slice(1).map((time, i) => time - times[i]!)).toEqual([
      1 * MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
    ]);
    expect(rowsFor(FAILING_CHAT)).toEqual([
      {
        id: expect.any(Number),
        job_type: SyncJobType.ForwardCatchup,
        status: "failed",
        attempts: 5,
        error_message: "connection reset",
      },
    ]);

    expect(chatSyncState.get(HEALTHY_CHAT)?.forward_cursor).toBe(1150);

    const logged = warnings();
    expect(logged[0]).toContain("attempt 1 of 5");
    expect(logged[0]).toContain("connection reset");
    expect(logged.at(-1)).toContain("failed for good (after 5 attempts)");

    await refreshCycles();
    expect(callsFor(FAILING_CHAT)).toHaveLength(5);
    expect(rowsFor(FAILING_CHAT)).toHaveLength(1);
    expectNoDuplicateRows();
  });

  it("fails a CHANNEL_PRIVATE chat at once and tries it again a day later", async () => {
    createChatsCache(db).upsert(
      dialogToCacheInput(
        fakeDialog({
          kind: "channel",
          id: PRIVATE_CHANNEL_ID,
          title: "Example News",
          username: "examplenews",
          membersCount: 5000,
        }),
      ),
    );
    chatSyncState.upsert({
      chat_id: PRIVATE_CHANNEL,
      chat_type: "channel",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    });
    failures.set(PRIVATE_CHANNEL, () => new tl.RpcError(400, "CHANNEL_PRIVATE"));
    await scheduler.initializeForStartup();

    await runFor(MINUTE);
    expect(callsFor(PRIVATE_CHANNEL)).toHaveLength(1);
    expect(rowsFor(PRIVATE_CHANNEL)).toMatchObject([
      { job_type: SyncJobType.InitialLoad, status: "failed", attempts: 1 },
    ]);
    expect(warnings()).toEqual([expect.stringContaining("failed for good (permanent error)")]);

    await refreshCycles();
    expect(callsFor(PRIVATE_CHANNEL)).toHaveLength(1);
    expectNoDuplicateRows();

    now = T0 + DAY + MINUTE;
    setSystemTime(now);
    pruneCache(db, { ...getDefaultRetentionConfig(), failedJobs: DAY }, { now });
    await refreshCycles();
    expect(callsFor(PRIVATE_CHANNEL)).toHaveLength(2);
    expect(rowsFor(PRIVATE_CHANNEL)).toMatchObject([
      { job_type: SyncJobType.InitialLoad, status: "failed", attempts: 1 },
    ]);
    expectNoDuplicateRows();
  });

  for (const [label, error] of [
    ["a transient error", () => new Error("connection reset")],
    ["a permanent error", () => new tl.RpcError(400, "CHANNEL_PRIVATE")],
  ] as const) {
    it(`drops the job of a chat turned off while its page was in flight, on ${label}`, async () => {
      failures.set(FAILING_CHAT, () => {
        chatSyncState.setSyncMode(FAILING_CHAT, "off");
        jobsService.cancelPendingForChat(FAILING_CHAT);
        return error();
      });
      await scheduler.initializeForStartup();

      await runFor(MINUTE);
      expect(callsFor(FAILING_CHAT)).toHaveLength(1);
      expect(rowsFor(FAILING_CHAT)).toEqual([]);
      expect(jobsService.countJobs().failed).toBe(0);

      await refreshCycles();
      expect(callsFor(FAILING_CHAT)).toHaveLength(1);
      expect(rowsFor(FAILING_CHAT)).toEqual([]);
      expectNoDuplicateRows();
    });
  }
});

describe("a chat that fails in one account", () => {
  let now: number;
  let dbs: Database[];

  beforeEach(() => {
    now = T0;
    setSystemTime(now);
    dbs = [];
  });

  afterEach(() => {
    setSystemTime();
    for (const db of dbs) db.close();
  });

  function seedAccount(ctx: DaemonContext, accountId: number, failure?: () => unknown) {
    const db = createAccountCacheDb();
    dbs.push(db);
    const chatSyncState = createChatSyncStateService(db);
    const jobsService = createSyncJobsService(db);
    const messagesCache = createMessagesCache(db);
    chatSyncState.upsert({
      chat_id: FAILING_CHAT,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: 1000,
      backward_cursor: 1,
    });
    chatSyncState.markHistoryComplete(FAILING_CHAT);
    chatSyncState.raiseTopMessageId(FAILING_CHAT, 1150);
    const history = createMultiChatHistory();
    history.set(FAILING_CHAT, range(1, 1150));
    const client = {
      call: async (request: GetHistoryRequest) => {
        if (failure) throw failure();
        return history.client.call(request as never);
      },
    } as unknown as TelegramClient;
    const scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    });
    addAccountRuntime(ctx, accountId, db, {
      scheduler,
      worker: createRealSyncWorker({
        client,
        messagesCache,
        historyRanges: createHistoryRanges(db),
        chatSyncState,
        jobsService,
        rateLimits: createRateLimitsService(db),
        chatsCache: createChatsCache(db),
        usersCache: createUsersCache(db),
        senderLookups: createSenderLookups(db),
      }),
    });
    ctx.state.accounts.set(accountId, {
      accountId,
      phone: `+1555000000${accountId}`,
      name: null,
      status: "connected",
      client,
    });
    return { db, chatSyncState, jobsService, scheduler, history };
  }

  it("doesn't stop the other account from queueing the same chat", async () => {
    const ctx: DaemonContext = testDaemonContext();
    const first = seedAccount(ctx, 1);
    const second = seedAccount(ctx, 2, () => new Error("connection reset"));
    const accounts = [first, second];
    for (const account of accounts) await account.scheduler.initializeForStartup();

    const runFor = async (ms: number) => {
      const end = now + ms;
      while (now < end) {
        now += 1000;
        setSystemTime(now);
        if ((now - T0) % 30_000 === 0) {
          for (const account of accounts) account.scheduler.refreshQueues();
        }
        await processJobs(ctx);
      }
    };

    await runFor(20 * MINUTE);
    const failedRows = (service: SyncJobsService) =>
      service.getFailedJobs(10).map((job) => job.chat_id);
    expect(failedRows(second.jobsService)).toEqual([FAILING_CHAT]);
    expect(failedRows(first.jobsService)).toEqual([]);
    expect(first.chatSyncState.get(FAILING_CHAT)?.forward_cursor).toBe(1150);

    first.history.set(FAILING_CHAT, range(1, 1200));
    first.chatSyncState.raiseTopMessageId(FAILING_CHAT, 1200);
    await runFor(2 * MINUTE);
    expect(first.chatSyncState.get(FAILING_CHAT)?.forward_cursor).toBe(1200);
    expect(second.chatSyncState.get(FAILING_CHAT)?.forward_cursor).toBe(1000);
    expect(failedRows(second.jobsService)).toEqual([FAILING_CHAT]);
  }, 30_000);
});
