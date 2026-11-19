import { describe, expect, it } from "bun:test";

import { dialogToCacheInput } from "../commands/chats/helpers";
import { createChatSyncStateService } from "./chat-sync-state";
import { createChatsCache } from "./chats-cache";
import { createHistoryRanges } from "./history-ranges";
import { createMessagesCache } from "./messages-cache";
import { createSyncJobsService } from "./sync-jobs";
import { SyncJobType, SyncPriority } from "./sync-schema";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { fakeDialog } from "../test/fake-dialogs.test-utils";
import { assertPeerIdInvariants } from "../test/peer-id-invariants.test-utils";

const BARE = 1234567890;

describe("assertPeerIdInvariants", () => {
  it("catches a supergroup's bare ID in every table that stores a chat", () => {
    const db = createAccountCacheDb();
    createChatsCache(db).upsert({
      ...dialogToCacheInput(fakeDialog({ kind: "supergroup", id: BARE, title: "Team Chat" })),
      chat_id: String(BARE),
    });
    createChatSyncStateService(db).upsert({
      chat_id: BARE,
      chat_type: "supergroup",
      sync_priority: SyncPriority.Medium,
      sync_enabled: true,
    });
    createMessagesCache(db).upsert({
      chat_id: BARE,
      message_id: 1,
      from_id: 10,
      text: "hello team",
      message_type: "text",
      date: 1_760_000_000,
      raw_json: "{}",
    });
    createSyncJobsService(db).create({
      chat_id: BARE,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.Medium,
    });
    createHistoryRanges(db).add(BARE, { low: 1, high: 1 });

    let message = "";
    try {
      assertPeerIdInvariants(db);
    } catch (err) {
      message = (err as Error).message;
    }

    for (const violation of [
      `chats_cache ${BARE} (supergroup) is user`,
      `chat_sync_state ${BARE} (supergroup) is user`,
      `messages_cache.chat_id ${BARE} is the bare ID of a supergroup`,
      `sync_jobs.chat_id ${BARE} is the bare ID of a supergroup`,
      `history_ranges.chat_id ${BARE} is the bare ID of a supergroup`,
    ]) {
      expect(message).toContain(violation);
    }
  });
});
