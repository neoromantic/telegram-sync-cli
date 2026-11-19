import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";

import { dialogToCacheInput } from "./helpers";
import { findCachedChatById } from "./lookup";
import { createChatSyncStateService } from "../../db/chat-sync-state";
import { createChatsCache } from "../../db/chats-cache";
import { createMessagesCache } from "../../db/messages-cache";
import { SyncPriority } from "../../db/sync-schema";
import { createUsersCache } from "../../db/users-cache";
import { createAccountCacheDb } from "../../test/cache-db.test-utils";
import { type FakeDialogInput, fakeDialog } from "../../test/fake-dialogs.test-utils";

describe("findCachedChatById", () => {
  let db: Database;

  beforeEach(() => {
    db = createAccountCacheDb();
  });

  function cacheDialog(input: FakeDialogInput) {
    createChatsCache(db).upsert(dialogToCacheInput(fakeDialog(input)));
  }

  const idOf = (input: string) => findCachedChatById(db, input)?.chat_id;

  it("finds a group or channel by the bare ID that 0.2.0 printed", () => {
    cacheDialog({ kind: "group", id: 4242, title: "Book Club" });
    cacheDialog({ kind: "channel", id: 1234567890, title: "Example News" });

    expect(idOf("4242")).toBe("-4242");
    expect(idOf("1234567890")).toBe("-1001234567890");
  });

  describe("a positive ID the cache knows as user N", () => {
    beforeEach(() => {
      cacheDialog({ kind: "group", id: 4242, title: "Book Club" });
      cacheDialog({ kind: "channel", id: 4242, title: "Example News" });
    });

    it("returns the private chat, not group -N or channel -100…N", () => {
      cacheDialog({ kind: "user", id: 4242, title: "Alice Able" });

      expect(findCachedChatById(db, "4242")).toMatchObject({
        chat_id: "4242",
        type: "private",
        title: "Alice Able",
      });
    });

    for (const [label, know] of [
      [
        "from users_cache",
        () =>
          createUsersCache(db).upsert({
            user_id: "4242",
            first_name: "Alice",
            fetched_at: Date.now(),
            raw_json: "{}",
          }),
      ],
      [
        "from its sync state, a DM seen only live",
        () =>
          createChatSyncStateService(db).upsert({
            chat_id: 4242,
            chat_type: "private",
            sync_priority: SyncPriority.High,
            sync_enabled: true,
          }),
      ],
      [
        "from its cached messages",
        () =>
          createMessagesCache(db).upsert({
            chat_id: 4242,
            message_id: 1,
            from_id: 4242,
            text: "hi",
            message_type: "text",
            date: 1_760_000_000,
            raw_json: "{}",
          }),
      ],
    ] as const) {
      it(`matches no group or channel when the user is known ${label}`, () => {
        know();

        expect(findCachedChatById(db, "4242")).toBeNull();
      });
    }
  });

  it("skips a bare group row that an older binary wrote under the positive ID", () => {
    createChatsCache(db).upsert({
      ...dialogToCacheInput(fakeDialog({ kind: "group", id: 4242, title: "Book Club" })),
      chat_id: "4242",
    });

    expect(findCachedChatById(db, "4242")).toBeNull();
  });

  it.each(["1e3", " 4242"])("matches nothing for %p", (input) => {
    cacheDialog({ kind: "group", id: 1000, title: "Book Club" });
    cacheDialog({ kind: "group", id: 4242, title: "Book Club" });

    expect(findCachedChatById(db, input)).toBeNull();
  });
});
