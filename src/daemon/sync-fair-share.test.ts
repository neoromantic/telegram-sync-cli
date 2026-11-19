import { describe, expect, it } from "bun:test";
import { processJobs } from "./daemon-scheduler";
import { createSyncPacer } from "./sync-pacing";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createSyncJobsService } from "../db/sync-jobs";
import { SyncJobType, SyncPriority } from "../db/sync-schema";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import {
  addAccountRuntime,
  realSyncParts,
  testDaemonContext,
} from "../test/daemon-runtime.test-utils";
import { createMultiChatHistory, range } from "../test/fake-history.test-utils";

const GAP_CHATS = range(10_001, 10_006);
const CAUGHT_UP_CHATS = range(20_001, 20_003);
const HISTORY_CHATS = range(30_001, 30_003);
const NEW_CHATS = range(40_001, 40_003);

const CURSOR = 1000;

describe("job budget", () => {
  it("shares the jobs between catch-up, first pages and history, and syncs every chat", async () => {
    const db = createAccountCacheDb();
    const chatSyncState = createChatSyncStateService(db);
    const jobsService = createSyncJobsService(db);
    const history = createMultiChatHistory();

    function seed(
      chatId: number,
      state: { forward?: number; backward?: number; top?: number; historyComplete?: boolean },
      messageIds: number[],
    ) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: state.forward,
        backward_cursor: state.backward,
      });
      if (state.historyComplete) chatSyncState.markHistoryComplete(chatId);
      if (state.top !== undefined) chatSyncState.raiseTopMessageId(chatId, state.top);
      history.set(chatId, messageIds);
    }

    for (const chatId of GAP_CHATS) {
      seed(
        chatId,
        { forward: CURSOR, backward: 1, top: 1150, historyComplete: true },
        range(1, 1150),
      );
    }
    for (const chatId of CAUGHT_UP_CHATS) {
      seed(
        chatId,
        { forward: CURSOR, backward: 1, top: CURSOR, historyComplete: true },
        range(1, CURSOR),
      );
    }
    for (const chatId of HISTORY_CHATS) {
      seed(chatId, { forward: CURSOR, backward: 301, top: CURSOR }, range(1, CURSOR));
    }
    for (const chatId of NEW_CHATS) {
      seed(chatId, {}, range(1, 300));
    }

    const ctx = testDaemonContext();
    const rt = addAccountRuntime(ctx, 1, db, realSyncParts(ctx, db, history.client));
    const scheduler = rt.scheduler!;
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: "+15550000000",
      name: null,
      status: "connected",
      client: history.client,
    });
    await scheduler.initializeForStartup();

    const ran: string[] = [];
    while (ran.length < 100) {
      if (ran.length > 0 && ran.length % 10 === 0) scheduler.refreshQueues();
      const job = scheduler.getNextJob();
      if (!job) break;
      rt.pacer = createSyncPacer();
      await processJobs(ctx);
      expect(jobsService.getById(job.id)?.status).toBe("completed");
      ran.push(job.job_type);
    }

    expect(ran.slice(0, 8)).toEqual([
      SyncJobType.ForwardCatchup,
      SyncJobType.InitialLoad,
      SyncJobType.ForwardCatchup,
      SyncJobType.BackwardHistory,
      SyncJobType.ForwardCatchup,
      SyncJobType.InitialLoad,
      SyncJobType.ForwardCatchup,
      SyncJobType.BackwardHistory,
    ]);
    for (const chatId of CAUGHT_UP_CHATS) {
      expect(history.requestsFor(chatId)).toHaveLength(0);
    }

    scheduler.refreshQueues();
    expect(scheduler.getNextJob()).toBeNull();
    expect(ran).toHaveLength(30);
    expect(history.requestCount).toBe(ran.length);

    const countOf = (sql: string, ...params: number[]) =>
      (db.query(sql).get(...params) as { n: number }).n;
    expect(countOf("SELECT COUNT(*) AS n FROM sync_jobs WHERE status != 'completed'")).toBe(0);
    for (const chatId of GAP_CHATS) {
      expect(
        countOf(
          "SELECT COUNT(*) AS n FROM messages_cache WHERE chat_id = ? AND message_id BETWEEN 1001 AND 1150",
          chatId,
        ),
      ).toBe(150);
      expect(chatSyncState.get(chatId)).toMatchObject({
        forward_cursor: 1150,
        top_message_id: 1150,
      });
    }
    for (const chatId of [...HISTORY_CHATS, ...NEW_CHATS]) {
      expect(
        countOf(
          "SELECT COUNT(*) AS n FROM messages_cache WHERE chat_id = ? AND message_id BETWEEN 1 AND 300",
          chatId,
        ),
      ).toBe(300);
    }
    expect(
      countOf(
        `SELECT COUNT(*) AS n FROM chat_sync_state
         WHERE forward_cursor IS NULL OR backward_cursor IS NULL OR history_complete = 0`,
      ),
    ).toBe(0);
    db.close();
  });
});
