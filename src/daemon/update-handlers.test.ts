import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it } from "bun:test";
import type { tl } from "@mtcute/bun";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { createUpdateHandlers, type UpdateContext, type UpdateHandlers } from "./handlers";
import { buildInputPeer } from "./sync-worker-real-helpers";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import { createSyncJobsService } from "../db/sync-jobs";
import { type SyncChatType, SyncJobType, SyncPriority } from "../db/sync-schema";
import { toLong } from "../utils/long";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { watchedLogger } from "../test/daemon-runtime.test-utils";
import { fakeDialog } from "../test/fake-dialogs.test-utils";
import { assertPeerIdInvariants } from "../test/peer-id-invariants.test-utils";

const ctx: UpdateContext = { accountId: 1, receivedAt: 0 };

describe("UpdateHandlers", () => {
  let db: Database;
  let handlers: UpdateHandlers;
  let messagesCache: ReturnType<typeof createMessagesCache>;
  let chatSyncState: ReturnType<typeof createChatSyncStateService>;

  beforeEach(() => {
    db = createAccountCacheDb();
    messagesCache = createMessagesCache(db);
    chatSyncState = createChatSyncStateService(db);
    handlers = createUpdateHandlers({ db, messagesCache, chatSyncState });
  });

  describe("handleNewMessage", () => {
    it("without a raw message, stores an empty object, logs once and queues a refetch (#130)", async () => {
      const logger = watchedLogger();
      handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        logger,
      });
      const jobs = createSyncJobsService(db);

      await handlers.handleNewMessage(ctx, {
        chatId: 100,
        messageId: 98,
        text: "With its raw message",
        date: 1_700_000_098,
        isOutgoing: false,
        rawMessage: { _: "message", id: 98 },
      });
      expect(jobs.getJobsForChat(100)).toEqual([]);

      for (const messageId of [99, 100]) {
        await handlers.handleNewMessage(ctx, {
          chatId: 100,
          messageId,
          fromId: 123,
          text: "No raw message",
          date: 1_700_000_000 + messageId,
          isOutgoing: false,
        });
      }

      expect(messagesCache.get(100, 99)?.raw_json).toBe("{}");
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(jobs.getJobsForChat(100)).toMatchObject([
        { job_type: SyncJobType.RefetchMessages, status: "pending" },
      ]);
    });

    it("gives a bot first seen live the newest page only (#131)", async () => {
      await handlers.handleNewMessage(ctx, {
        chatId: 5001,
        chatType: "private",
        messageId: 1,
        text: "Your order has shipped",
        date: 1_700_000_000,
        isOutgoing: false,
        rawChat: {
          _: "user",
          id: 5001,
          firstName: "Example Bot",
          bot: true,
        } as tl.RawUser,
      });

      expect(chatSyncState.get(5001)).toMatchObject({
        sync_policy: "bot",
        sync_priority: SyncPriority.Medium,
        sync_enabled: 1,
      });
    });

    it("never moves the forward cursor or the newest message ID, nor sets a cursor", async () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: "private",
        sync_priority: 1,
        sync_enabled: true,
        forward_cursor: 5,
      });
      chatSyncState.raiseTopMessageId(100, 5);

      for (const [chatId, messageId] of [
        [100, 6],
        [100, 50],
        [100, 3],
        [102, 10],
      ] as const) {
        await handlers.handleNewMessage(ctx, {
          chatId,
          messageId,
          text: `Live ${messageId}`,
          date: 1_700_000_000 + messageId,
          isOutgoing: false,
        });
      }

      expect(chatSyncState.get(100)).toMatchObject({
        forward_cursor: 5,
        top_message_id: 5,
      });
      expect(chatSyncState.get(102)?.forward_cursor).toBeNull();
    });

    it("counts each new message once for its chat and stamps its forward sync", async () => {
      for (const messageId of [1, 2, 2]) {
        await handlers.handleNewMessage(ctx, {
          chatId: 101,
          messageId,
          text: `Message ${messageId}`,
          date: 1_700_000_000 + messageId,
          isOutgoing: false,
        });
      }

      const state = chatSyncState.get(101);
      expect(state?.synced_messages).toBe(2);
      expect(state?.last_forward_sync).not.toBeNull();
    });
  });

  describe("handleNewMessage in a chat no dialog pass listed", () => {
    let chatsCache: ReturnType<typeof createChatsCache>;

    beforeEach(() => {
      chatsCache = createChatsCache(db);
      handlers = createUpdateHandlers({
        db,
        messagesCache,
        chatSyncState,
        chatsCache,
      });
    });

    function receive(chatId: number, chatType: SyncChatType, rawChat: tl.TypeUser | tl.TypeChat) {
      return handlers.handleNewMessage(ctx, {
        chatId,
        chatType,
        memberCount: rawChat._ === "chat" ? rawChat.participantsCount : null,
        messageId: 1,
        text: "Hello",
        date: 1_700_000_000,
        isOutgoing: false,
        rawChat,
      });
    }

    it("caches a new basic group and channel", async () => {
      await receive(-4001, "group", {
        _: "chat",
        id: 4001,
        title: "Book Club",
        participantsCount: 12,
      } as tl.RawChat);
      await receive(-1001234567890, "channel", {
        _: "channel",
        id: 1234567890,
        accessHash: toLong(888),
        title: "Example News",
      } as tl.RawChannel);

      expect(buildInputPeer(-4001, chatsCache)).toEqual({
        _: "inputPeerChat",
        chatId: 4001,
      });
      expect(buildInputPeer(-1001234567890, chatsCache)).toEqual({
        _: "inputPeerChannel",
        channelId: 1234567890,
        accessHash: toLong(888),
      });
    });

    it("skips a min user, whose access hash works only in its update", async () => {
      await receive(5550002, "private", {
        _: "user",
        id: 5550002,
        min: true,
        accessHash: toLong(999),
      } as tl.RawUser);

      expect(chatsCache.getById("5550002")).toBeNull();
      expect(messagesCache.get(5550002, 1)).not.toBeNull();
    });

    it("leaves a supergroup row a dialog pass wrote alone", async () => {
      chatsCache.upsert(
        dialogToCacheInput(
          fakeDialog({
            kind: "supergroup",
            id: 1234567890,
            title: "Team Chat",
            topMessage: 41,
          }),
        ),
      );

      await receive(-1001234567890, "supergroup", {
        _: "channel",
        id: 1234567890,
        megagroup: true,
        accessHash: toLong(888),
        title: "Renamed",
      } as tl.RawChannel);

      expect(chatsCache.getById("-1001234567890")).toMatchObject({
        title: "Team Chat",
        access_hash: "777",
        last_message_id: 41,
      });
      expect(chatsCache.count()).toBe(1);
      assertPeerIdInvariants(db);
    });
  });

  describe("handleEditMessage", () => {
    it("updates message text", async () => {
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1,
        text: "Original text",
        message_type: "text",
        date: 1_700_000_000,
        raw_json: "{}",
      });

      await handlers.handleEditMessage(ctx, {
        chatId: 100,
        messageId: 1,
        newText: "Edited text",
        editDate: 1_700_000_100,
      });

      const cached = messagesCache.get(100, 1);
      expect(cached?.text).toBe("Edited text");
      expect(cached?.is_edited).toBe(1);
    });
  });
});

describe("UpdateHandlers error handling", () => {
  it("logs a failed write with the update it was for and goes on", async () => {
    const db = createAccountCacheDb();
    const messagesCache = createMessagesCache(db);
    const logger = watchedLogger();
    const handlers = createUpdateHandlers({
      db,
      messagesCache,
      chatSyncState: createChatSyncStateService(db),
      logger,
    });
    for (const messageId of [5, 10, 11]) {
      messagesCache.upsert({
        chat_id: 200,
        message_id: messageId,
        text: `made-up message ${messageId}`,
        message_type: "text",
        date: 1_760_000_000,
        raw_json: "{}",
      });
    }
    for (const statement of ["INSERT", "UPDATE"]) {
      db.run(
        `CREATE TRIGGER fail_messages_${statement.toLowerCase()} BEFORE ${statement} ON messages_cache
         BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`,
      );
    }

    await handlers.handleNewMessage(ctx, {
      chatId: 100,
      messageId: 1,
      text: "Hello",
      date: 1_760_000_001,
      isOutgoing: false,
    });
    await handlers.handleEditMessage(ctx, {
      chatId: 200,
      messageId: 5,
      newText: "Edited",
      editDate: 1_760_000_002,
    });
    await handlers.handleDeleteMessages(ctx, { chatId: 200, messageIds: [10, 11] });

    const lines = logger.error.mock.calls.map(([line]) => String(line));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toStartWith("Failed to handle new message: chatId=100, messageId=1, error=");
    expect(lines[1]).toStartWith("Failed to handle edit message: chatId=200, messageId=5, error=");
    expect(lines[2]).toStartWith(
      "Failed to handle delete messages: chatId=200, messageIds=[10,11], error=",
    );
    for (const line of lines) expect(line).toContain("disk I/O error");
  });
});
