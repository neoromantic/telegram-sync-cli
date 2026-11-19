import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import { processJobs } from "./daemon-scheduler";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { SyncJobType, SyncPriority } from "../db/sync-schema";
import { toPeerIdFromInputPeer } from "../utils/telegram-peer-ids";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import {
  addAccountRuntime,
  realSyncParts,
  testDaemonContext,
} from "../test/daemon-runtime.test-utils";
import {
  createMultiChatHistory,
  type GetHistoryRequest,
  range,
} from "../test/fake-history.test-utils";

const T0 = 1_700_000_000_000;
const MINUTE = 60_000;

const FAILING_CHAT = 50_001;
const HEALTHY_CHAT = 50_002;

afterEach(() => {
  setSystemTime();
});

describe("a chat whose sync pages keep failing", () => {
  it("retries a transient error after 1, 2, 4 and 8 minutes, then gives up", async () => {
    let now = T0;
    setSystemTime(now);
    const db = createAccountCacheDb();
    const chatSyncState = createChatSyncStateService(db);
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

    const failedCalls: number[] = [];
    const client = {
      call: async (request: GetHistoryRequest) => {
        if (request.peer && toPeerIdFromInputPeer(request.peer, null) === FAILING_CHAT) {
          failedCalls.push(now);
          throw new Error("connection reset");
        }
        return history.client.call(request as never);
      },
    } as unknown as TelegramClient;
    const ctx = testDaemonContext();
    const scheduler = addAccountRuntime(ctx, 1, db, realSyncParts(ctx, db, client)).scheduler!;
    ctx.state.accounts.set(1, {
      accountId: 1,
      phone: "+15550000000",
      name: null,
      status: "connected",
      client,
    });
    await scheduler.initializeForStartup();

    const end = now + 20 * MINUTE;
    while (now < end) {
      now += 10_000;
      setSystemTime(now);
      if ((now - T0) % 30_000 === 0) scheduler.refreshQueues();
      await processJobs(ctx);
    }

    expect(failedCalls.slice(1).map((time, i) => time - failedCalls[i]!)).toEqual([
      1 * MINUTE,
      2 * MINUTE,
      4 * MINUTE,
      8 * MINUTE,
    ]);
    expect(
      db
        .query("SELECT job_type, status, attempts, error_message FROM sync_jobs WHERE chat_id = ?")
        .all(FAILING_CHAT),
    ).toEqual([
      {
        job_type: SyncJobType.ForwardCatchup,
        status: "failed",
        attempts: 5,
        error_message: "connection reset",
      },
    ]);
    expect(chatSyncState.get(HEALTHY_CHAT)?.forward_cursor).toBe(1150);
    db.close();
  });
});
