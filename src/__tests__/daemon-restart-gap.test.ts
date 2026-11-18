import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import type { AccountRuntime, DaemonContext } from "../daemon/daemon-context";
import { processJobs } from "../daemon/daemon-scheduler";
import { createUpdateHandlers, type UpdateHandlers } from "../daemon/handlers";
import { createSyncScheduler, type SyncScheduler } from "../daemon/scheduler";
import { createSyncPacer } from "../daemon/sync-pacing";
import { createRealSyncWorker } from "../daemon/sync-worker-real";
import { type ChatSyncStateService, createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache, type MessagesCache } from "../db/messages-cache";
import { createRateLimitsService } from "../db/rate-limits";
import { createSenderLookups } from "../db/sender-lookups";
import { createSyncJobsService } from "../db/sync-jobs";
import { SyncPriority } from "../db/sync-schema";
import { createUsersCache } from "../db/users-cache";
import { createAccountCacheDb } from "./helpers/cache-db";
import { addAccountRuntime, testDaemonContext } from "./helpers/daemon-runtime";
import { createFakeHistory, range } from "./helpers/fake-history";

const CHAT_ID = 4242;
const CURSOR = 1000;

describe("daemon restart with messages missed while stopped", () => {
  let db: Database;
  let messagesCache: MessagesCache;
  let chatSyncState: ChatSyncStateService;
  let scheduler: SyncScheduler;
  let handlers: UpdateHandlers;
  let ctx: DaemonContext;
  let rt: AccountRuntime;

  let history: ReturnType<typeof createFakeHistory>;

  beforeEach(() => {
    db = createAccountCacheDb();
    messagesCache = createMessagesCache(db);
    chatSyncState = createChatSyncStateService(db);
    const jobsService = createSyncJobsService(db);
    const rateLimits = createRateLimitsService(db);

    chatSyncState.upsert({
      chat_id: CHAT_ID,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: CURSOR,
      backward_cursor: 1,
    });
    chatSyncState.markHistoryComplete(CHAT_ID);
    chatSyncState.incrementSyncedMessages(CHAT_ID, CURSOR);
    messagesCache.upsertBatch(
      range(1, CURSOR).map((id) => ({
        chat_id: CHAT_ID,
        message_id: id,
        message_type: "text",
        date: 1_700_000_000 + id,
        raw_json: "{}",
      })),
    );

    history = createFakeHistory(range(1, 1150));

    ctx = testDaemonContext();

    rt = addAccountRuntime(ctx, 1, db);
    handlers = createUpdateHandlers({
      db,
      messagesCache,
      chatSyncState,
      onMessagesSynced: (count) => {
        rt.messagesSynced += count;
      },
    });
    scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    });
    rt.scheduler = scheduler;
    rt.worker = createRealSyncWorker({
      client: history.client,
      messagesCache,
      historyRanges: createHistoryRanges(db),
      chatSyncState,
      jobsService,
      rateLimits,
      chatsCache: createChatsCache(db),
      usersCache: createUsersCache(db),
      senderLookups: createSenderLookups(db),
    });
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: "+15550000000",
      name: null,
      status: "connected",
      client: history.client,
    });
  });

  afterEach(() => {
    db.close();
  });

  async function receiveLive(messageId: number) {
    history.add(messageId);
    await handlers.handleNewMessage(
      { accountId: 1, receivedAt: Date.now() },
      {
        chatId: CHAT_ID,
        chatType: "private",
        messageId,
        text: `msg ${messageId}`,
        date: 1_700_000_000 + messageId,
        isOutgoing: false,
        rawMessage: {
          _: "message",
          id: messageId,
          peerId: { _: "peerUser", userId: CHAT_ID },
          message: `msg ${messageId}`,
          date: 1_700_000_000 + messageId,
        },
      },
    );
  }

  async function runNextJob(): Promise<boolean> {
    if (!scheduler.getNextJob()) return false;
    rt.pacer = createSyncPacer();
    await processJobs(ctx);
    return true;
  }

  async function drainJobs() {
    for (let i = 0; i < 20; i++) {
      if (!(await runNextJob())) return;
    }
    throw new Error("sync jobs did not drain");
  }

  function missingIds(from: number, to: number): number[] {
    return range(from, to).filter((id) => messagesCache.get(CHAT_ID, id) === null);
  }

  it("caches every missed message when a live one arrives first", async () => {
    await scheduler.initializeForStartup();
    await receiveLive(1151);

    expect(chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(CURSOR);

    await drainJobs();

    expect(missingIds(1001, 1151)).toEqual([]);
    expect(history.requests).toHaveLength(2);

    const state = chatSyncState.get(CHAT_ID);
    expect(state?.forward_cursor).toBe(1151);
    expect(state?.synced_messages).toBe(CURSOR + 151);
    expect(rt.messagesSynced).toBe(151);
  });

  it("keeps up with live messages that arrive during catch-up", async () => {
    await scheduler.initializeForStartup();
    await receiveLive(1151);

    await runNextJob();
    await receiveLive(1152);
    await drainJobs();

    expect(missingIds(1001, 1152)).toEqual([]);
    expect(chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(1152);
  });

  it("resumes from the cursor after a FLOOD_WAIT between pages", async () => {
    const call = history.client.call.bind(history.client);
    let calls = 0;
    const client = {
      call: async (request: Parameters<TelegramClient["call"]>[0]) => {
        calls++;
        if (calls === 2) throw new Error("FLOOD_WAIT_30");
        return call(request);
      },
    } as unknown as TelegramClient;
    rt.worker = createRealSyncWorker({
      client,
      messagesCache,
      historyRanges: createHistoryRanges(db),
      chatSyncState,
      jobsService: createSyncJobsService(db),
      rateLimits: createRateLimitsService(db),
      chatsCache: createChatsCache(db),
      usersCache: createUsersCache(db),
      senderLookups: createSenderLookups(db),
    });

    await scheduler.initializeForStartup();
    await receiveLive(1151);
    await drainJobs();

    expect(chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(1100);
    expect(missingIds(1001, 1100)).toEqual([]);

    const realNow = Date.now;
    const later = realNow() + 31_000;
    Date.now = () => later;
    try {
      scheduler.refreshQueues();
      await drainJobs();
    } finally {
      Date.now = realNow;
    }

    expect(missingIds(1001, 1151)).toEqual([]);
    expect(chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(1151);
  });
});

describe("daemon restart with two accounts", () => {
  function seedAccount(ctx: DaemonContext, accountId: number, cursor: number, top: number) {
    const db = createAccountCacheDb();
    const messagesCache = createMessagesCache(db);
    const chatSyncState = createChatSyncStateService(db);
    const jobsService = createSyncJobsService(db);
    chatSyncState.upsert({
      chat_id: CHAT_ID,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      forward_cursor: cursor,
      backward_cursor: 1,
    });
    chatSyncState.markHistoryComplete(CHAT_ID);
    chatSyncState.raiseTopMessageId(CHAT_ID, top);
    messagesCache.upsertBatch(
      range(1, cursor).map((id) => ({
        chat_id: CHAT_ID,
        message_id: id,
        message_type: "text",
        date: 1_700_000_000 + id,
        raw_json: "{}",
      })),
    );
    const history = createFakeHistory(range(1, top));
    const scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    });
    addAccountRuntime(ctx, accountId, db, {
      scheduler,
      worker: createRealSyncWorker({
        client: history.client,
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
      client: history.client,
    });
    return { db, messagesCache, chatSyncState, history, scheduler };
  }

  it("catches each account up from its own cursor, in its own cache", async () => {
    const ctx: DaemonContext = testDaemonContext();
    const first = seedAccount(ctx, 1, CURSOR, 1150);
    const second = seedAccount(ctx, 2, 300, 320);
    await first.scheduler.initializeForStartup();
    await second.scheduler.initializeForStartup();

    for (let i = 0; i < 40; i++) {
      if (!first.scheduler.getNextJob() && !second.scheduler.getNextJob()) {
        break;
      }
      for (const rt of ctx.runtime.accounts.values()) rt.pacer = createSyncPacer();
      await processJobs(ctx);
    }

    expect(first.chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(1150);
    expect(second.chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(320);
    for (const [account, top] of [
      [first, 1150],
      [second, 320],
    ] as const) {
      const missing = range(1, top).filter((id) => account.messagesCache.get(CHAT_ID, id) === null);
      expect(missing).toEqual([]);
      expect(account.messagesCache.get(CHAT_ID, top + 1)).toBeNull();
    }
    expect(second.history.requests.map((r) => r.minId)).toEqual([300]);
    expect(first.history.requests[0]?.minId).toBe(CURSOR);

    first.db.close();
    second.db.close();
  });
});
