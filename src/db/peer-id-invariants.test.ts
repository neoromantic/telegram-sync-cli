import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

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
const MARKED = -1001234567890;

describe("assertPeerIdInvariants", () => {
  let db: Database;

  beforeEach(() => {
    db = createAccountCacheDb();
  });

  function syncState(chatId: number) {
    createChatSyncStateService(db).upsert({
      chat_id: chatId,
      chat_type: "supergroup",
      sync_priority: SyncPriority.Medium,
      sync_enabled: true,
    });
  }

  function cacheMessage(chatId: number) {
    createMessagesCache(db).upsert({
      chat_id: chatId,
      message_id: 1,
      from_id: 10,
      text: "hello team",
      message_type: "text",
      date: 1_760_000_000,
      raw_json: "{}",
    });
  }

  it("passes a cache in one format", () => {
    createChatsCache(db).upsert(
      dialogToCacheInput(fakeDialog({ kind: "supergroup", id: BARE, title: "Team Chat" })),
    );
    syncState(MARKED);
    cacheMessage(MARKED);
    cacheMessage(10);

    expect(() => assertPeerIdInvariants(db)).not.toThrow();
  });

  it("catches a supergroup in chat_sync_state under its bare ID", () => {
    syncState(BARE);

    expect(() => assertPeerIdInvariants(db)).toThrow(
      `chat_sync_state ${BARE} (supergroup) is user`,
    );
  });

  for (const [table, write] of [
    ["messages_cache", () => cacheMessage(BARE)],
    [
      "sync_jobs",
      () =>
        createSyncJobsService(db).create({
          chat_id: BARE,
          job_type: SyncJobType.InitialLoad,
          priority: SyncPriority.Medium,
        }),
    ],
    ["history_ranges", () => createHistoryRanges(db).add(BARE, { low: 1, high: 1 })],
  ] as const) {
    it(`catches a supergroup's bare ID in ${table}`, () => {
      createChatsCache(db).upsert({
        ...dialogToCacheInput(fakeDialog({ kind: "supergroup", id: BARE, title: "Team Chat" })),
        chat_id: String(BARE),
      });
      write();

      expect(() => assertPeerIdInvariants(db)).toThrow(
        `${table}.chat_id ${BARE} is the bare ID of a supergroup`,
      );
    });
  }
});
