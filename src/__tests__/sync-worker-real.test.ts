/**
 * Tests for real sync worker wrapper behavior
 */
import { describe, expect, it, mock } from "bun:test";
import type { TelegramClient } from "@mtcute/bun";
import { createRealSyncWorker } from "../daemon/sync-worker-real";
import type { ChatSyncStateService } from "../db/chat-sync-state";
import type { ChatsCache } from "../db/chats-cache";
import type { HistoryRanges } from "../db/history-ranges";
import type { MessagesCache } from "../db/messages-cache";
import type { RateLimitsService } from "../db/rate-limits";
import type { SenderLookups } from "../db/sender-lookups";
import type { SyncJobsService } from "../db/sync-jobs";
import type { UsersCache } from "../db/users-cache";

describe("createRealSyncWorker", () => {
  it("uses overridden config when checking rate limits", () => {
    const rateLimits = {
      isBlocked: mock(() => false),
    } satisfies Pick<RateLimitsService, "isBlocked">;

    const worker = createRealSyncWorker({
      client: {} as unknown as TelegramClient,
      messagesCache: {} as unknown as MessagesCache,
      historyRanges: {} as unknown as HistoryRanges,
      chatSyncState: {} as unknown as ChatSyncStateService,
      jobsService: {} as unknown as SyncJobsService,
      rateLimits: rateLimits as unknown as RateLimitsService,
      chatsCache: {} as unknown as ChatsCache,
      usersCache: {} as unknown as UsersCache,
      senderLookups: {} as unknown as SenderLookups,
      config: {
        apiMethod: "messages.search",
        batchSize: 5,
      },
    });

    worker.canMakeApiCall();

    expect(rateLimits.isBlocked).toHaveBeenCalledWith("messages.search");
  });
});
