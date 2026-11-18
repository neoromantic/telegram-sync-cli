import { describe, expect, it } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import { createRealSyncWorker } from "./sync-worker-real";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { createRateLimitsService } from "../db/rate-limits";
import { createSenderLookups } from "../db/sender-lookups";
import { createSyncJobsService } from "../db/sync-jobs";
import { createUsersCache } from "../db/users-cache";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

describe("createRealSyncWorker", () => {
  it("uses overridden config when checking rate limits", () => {
    const db = createAccountCacheDb();
    const rateLimits = createRateLimitsService(db);

    const worker = createRealSyncWorker({
      client: {} as unknown as TelegramClient,
      messagesCache: createMessagesCache(db),
      historyRanges: createHistoryRanges(db),
      chatSyncState: createChatSyncStateService(db),
      jobsService: createSyncJobsService(db),
      rateLimits,
      chatsCache: createChatsCache(db),
      usersCache: createUsersCache(db),
      senderLookups: createSenderLookups(db),
      config: {
        apiMethod: "messages.search",
        batchSize: 5,
      },
    });

    rateLimits.setFloodWait("messages.getHistory", 60);
    expect(worker.canMakeApiCall()).toBe(true);

    rateLimits.setFloodWait("messages.search", 60);
    expect(worker.canMakeApiCall()).toBe(false);
    db.close();
  });
});
