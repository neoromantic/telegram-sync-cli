import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import type { AccountRuntime, DaemonContext } from "./daemon-context";
import { processJobs } from "./daemon-scheduler";
import { createUpdateHandlers, type UpdateHandlers } from "./handlers";
import type { SyncScheduler } from "./scheduler";
import { createSyncPacer } from "./sync-pacing";
import { type ChatSyncStateService, createChatSyncStateService } from "../db/chat-sync-state";
import { createMessagesCache, type MessagesCache } from "../db/messages-cache";
import { SyncPriority } from "../db/sync-schema";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import {
  addAccountRuntime,
  realSyncParts,
  testDaemonContext,
} from "../test/daemon-runtime.test-utils";
import { createFakeHistory, range } from "../test/fake-history.test-utils";

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

    rt = addAccountRuntime(ctx, 1, db, realSyncParts(ctx, db, history.client));
    scheduler = rt.scheduler!;
    handlers = createUpdateHandlers({
      db,
      messagesCache,
      chatSyncState,
      onMessagesSynced: (count) => {
        rt.messagesSynced += count;
      },
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

  async function runNextJob() {
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

  function missingIds(from: number, to: number) {
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
    rt.worker = realSyncParts(ctx, db, client).worker;

    await scheduler.initializeForStartup();
    await receiveLive(1151);
    await drainJobs();

    expect(chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(1100);
    expect(missingIds(1001, 1100)).toEqual([]);

    setSystemTime(Date.now() + 31_000);
    try {
      scheduler.refreshQueues();
      await drainJobs();
    } finally {
      setSystemTime();
    }

    expect(missingIds(1001, 1151)).toEqual([]);
    expect(chatSyncState.get(CHAT_ID)?.forward_cursor).toBe(1151);
  });
});
