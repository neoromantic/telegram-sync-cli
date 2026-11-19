import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";
import { type ChatSyncStateService, createChatSyncStateService } from "./chat-sync-state";
import { SyncPriority } from "./sync-schema";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

describe("ChatSyncStateService", () => {
  let service: ChatSyncStateService;

  beforeEach(() => {
    service = createChatSyncStateService(createAccountCacheDb());
  });

  afterEach(() => {
    setSystemTime();
  });

  describe("upsert member_count", () => {
    it("keeps the stored count when the update has none", () => {
      service.upsert({
        chat_id: -4001,
        chat_type: "group",
        member_count: 42,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      });

      service.upsert({
        chat_id: -4001,
        chat_type: "group",
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      });
      expect(service.get(-4001)?.member_count).toBe(42);

      service.upsert({
        chat_id: -4001,
        chat_type: "group",
        member_count: 12,
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      });
      expect(service.get(-4001)?.member_count).toBe(12);
    });
  });

  describe("setSyncMode", () => {
    const CHANNEL = -1001234567890;

    beforeEach(() => {
      service.upsert({
        chat_id: CHANNEL,
        chat_type: "channel",
        member_count: 5000,
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
      });
    });

    const passUpsert = (enabled: boolean, memberCount?: number) =>
      service.upsert({
        chat_id: CHANNEL,
        chat_type: "supergroup",
        member_count: memberCount,
        sync_priority: enabled ? SyncPriority.High : SyncPriority.Low,
        sync_enabled: enabled,
      });

    it("writes the sync_enabled and sync_priority each mode means", () => {
      service.setSyncMode(CHANNEL, "on");
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: "on",
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
      });

      service.setSyncMode(CHANNEL, "off");
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: "off",
        sync_enabled: 0,
      });

      service.setSyncMode(CHANNEL, "auto");
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: "auto",
        sync_enabled: 0,
        sync_priority: SyncPriority.Low,
      });
    });

    it("keeps a chat turned on or off through a dialog pass", () => {
      service.setSyncMode(CHANNEL, "on");
      passUpsert(false, 6000);
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: "on",
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
        chat_type: "supergroup",
        member_count: 6000,
      });

      service.setSyncMode(CHANNEL, "off");
      passUpsert(true, 10);
      expect(service.get(CHANNEL)).toMatchObject({
        sync_mode: "off",
        sync_enabled: 0,
        member_count: 10,
      });
    });

    it("lets the policy decide under auto", () => {
      passUpsert(true, 10);
      expect(service.get(CHANNEL)).toMatchObject({
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
      });

      passUpsert(false);
      expect(service.get(CHANNEL)).toMatchObject({
        sync_enabled: 0,
        sync_priority: SyncPriority.Low,
      });
    });
  });

  describe("top_message_id", () => {
    beforeEach(() => {
      service.upsert({
        chat_id: 100,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
      });
    });

    const due = () => service.getCatchupDue().map((chat) => chat.chat_id);

    it("is due while the top is unknown or above the cursor, for enabled chats with a cursor", () => {
      service.upsert({
        chat_id: 200,
        chat_type: "private",
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      });
      service.upsert({
        chat_id: 300,
        chat_type: "channel",
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
        forward_cursor: 10,
      });
      expect(service.get(100)?.top_message_id).toBeNull();
      expect(due()).toEqual([100]);

      service.raiseTopMessageId(100, 1000);
      expect(due()).toEqual([]);
    });

    it("only rises", () => {
      service.raiseTopMessageId(100, 1150);
      service.raiseTopMessageId(100, 1100);
      expect(service.get(100)?.top_message_id).toBe(1150);
      expect(due()).toEqual([100]);
    });

    it("settles at the new cursor after a page that reached the newest message", () => {
      service.raiseTopMessageId(100, 1200);
      service.recordCatchupPage(100, {
        forward_cursor: 1150,
        new_messages: 150,
        caught_up: true,
        top_before: 1200,
      });

      const state = service.get(100);
      expect(state?.forward_cursor).toBe(1150);
      expect(state?.top_message_id).toBe(1150);
      expect(state?.synced_messages).toBe(150);
      expect(state?.last_forward_sync).not.toBeNull();
      expect(due()).toEqual([]);
    });

    it("keeps a top that rose during the fetch", () => {
      service.raiseTopMessageId(100, 1150);
      service.raiseTopMessageId(100, 1160);
      service.recordCatchupPage(100, {
        forward_cursor: 1150,
        new_messages: 150,
        caught_up: true,
        top_before: 1150,
      });

      expect(service.get(100)?.top_message_id).toBe(1160);
      expect(due()).toEqual([100]);
    });

    it("leaves the top alone after a full page", () => {
      service.raiseTopMessageId(100, 1150);
      service.recordCatchupPage(100, {
        forward_cursor: 1100,
        new_messages: 100,
        caught_up: false,
        top_before: 1150,
      });

      expect(service.get(100)?.top_message_id).toBe(1150);
      expect(due()).toEqual([100]);
    });

    it("marks chats caught up or unknown", () => {
      service.markCaughtUp([100]);
      expect(service.get(100)?.top_message_id).toBe(1000);

      service.markTopUnknown([100]);
      expect(service.get(100)?.top_message_id).toBeNull();
    });
  });

  it("stamps the last forward and backward sync", () => {
    service.upsert({
      chat_id: 100,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    });

    setSystemTime(1_700_000_000_000);
    service.updateLastSync(100, "forward");
    setSystemTime(1_700_000_060_000);
    service.updateLastSync(100, "backward");

    expect(service.get(100)).toMatchObject({
      last_forward_sync: 1_700_000_000_000,
      last_backward_sync: 1_700_000_060_000,
    });
  });
});
