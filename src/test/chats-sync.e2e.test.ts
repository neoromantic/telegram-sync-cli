import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { fakeDialog, fakeRawCommunity } from "./fake-dialogs.test-utils";
import { takePartIn } from "./participation.test-utils";
import { assertPeerIdInvariants } from "./peer-id-invariants.test-utils";
import { dialogToCacheInput, rawChatToCacheInput } from "../commands/chats/helpers";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createSyncJobsService } from "../db/sync-jobs";
import { SyncJobType, SyncPriority } from "../db/sync-schema";
import { NO_CREDENTIALS, runCliFailure, runCliSuccess } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const CHANNEL_ID = 1234567890;
const CHANNEL_PEER_ID = -1001234567890;
const GROUP_ID = 4001;
const GROUP_PEER_ID = -4001;

interface SyncResult {
  success: boolean;
  data: {
    id: number;
    peerId: number;
    type: string;
    title: string | null;
    username: string | null;
    mode: string;
    syncEnabled: boolean;
    syncReason: string;
    lastOwnMessageAt: number | null;
    historyComplete: boolean;
    syncedMessages: number;
    changed: boolean;
    clearedFailedJobs: number;
  };
}

describe("E2E: chats sync", () => {
  let env: TestEnvironment;
  let cacheDb: Database;

  beforeEach(() => {
    env = createTestEnvironment("chats-sync");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000001", is_active: true }]);

    cacheDb = env.openCacheDb(1);
    createChatsCache(cacheDb).upsertMany(
      [
        fakeDialog({
          kind: "channel",
          id: CHANNEL_ID,
          title: "Example News",
          username: "examplenews",
          membersCount: 5000,
        }),
        fakeDialog({
          kind: "group",
          id: GROUP_ID,
          title: "Book Club",
          membersCount: 50,
        }),
      ].map(dialogToCacheInput),
    );
  });

  afterEach(() => {
    assertPeerIdInvariants(cacheDb);
    env.cleanup();
  });

  function options() {
    return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } };
  }

  async function sync(...args: string[]) {
    const result = await runCliSuccess(["chats", "sync", ...args], options());
    return result.json as SyncResult;
  }

  function stateOf(chatId: number) {
    return createChatSyncStateService(cacheDb).get(chatId);
  }

  async function listedId() {
    const list = await runCliSuccess(["chats", "list"], options());
    const items = (list.json as { data: { items: Array<{ id: number; username: string }> } }).data
      .items;
    const channel = items.find((item) => item.username === "examplenews");
    expect(channel?.id).toBe(CHANNEL_PEER_ID);
    return String(channel?.id);
  }

  for (const [label, chat] of [
    ["@username", async () => "@examplenews"],
    ["the ID from tg chats list", listedId],
  ] as const) {
    it(`turns sync on for ${label}`, async () => {
      const result = await sync(await chat());

      expect(result).toEqual({
        success: true,
        data: {
          id: CHANNEL_PEER_ID,
          peerId: CHANNEL_PEER_ID,
          type: "channel",
          title: "Example News",
          username: "examplenews",
          mode: "on",
          syncEnabled: true,
          syncReason: "on_by_hand",
          lastOwnMessageAt: null,
          historyComplete: false,
          syncedMessages: 0,
          changed: true,
          clearedFailedJobs: 0,
        },
      });
      expect(stateOf(CHANNEL_PEER_ID)).toMatchObject({
        chat_type: "channel",
        member_count: 5000,
        sync_mode: "on",
        sync_enabled: 1,
        sync_priority: SyncPriority.High,
      });
    });
  }

  it("turns sync off and drops the chat pending jobs", async () => {
    await sync(String(GROUP_PEER_ID));
    const jobs = createSyncJobsService(cacheDb);
    jobs.create({
      chat_id: GROUP_PEER_ID,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.Realtime,
    });

    const result = await sync(String(GROUP_ID), "--off");

    expect(result.data).toMatchObject({
      id: GROUP_PEER_ID,
      peerId: GROUP_PEER_ID,
      type: "group",
      mode: "off",
      syncEnabled: false,
      changed: true,
    });
    expect(stateOf(GROUP_PEER_ID)).toMatchObject({
      sync_mode: "off",
      sync_enabled: 0,
    });
    expect(jobs.getPendingJobs()).toEqual([]);
  });

  describe("a chat whose sync jobs failed", () => {
    function failJobs(chatId: number, count: number) {
      const jobs = createSyncJobsService(cacheDb);
      for (let i = 0; i < count; i++) {
        const job = jobs.create({
          chat_id: chatId,
          job_type: i === 0 ? SyncJobType.InitialLoad : SyncJobType.BackwardHistory,
          priority: SyncPriority.High,
        });
        jobs.markRunning(job.id);
        jobs.markFailed(job.id, "Telegram API error 400: CHANNEL_PRIVATE");
      }
    }

    const failedOf = (chatId: number) =>
      createSyncJobsService(cacheDb)
        .getFailedJobs(10)
        .filter((job) => job.chat_id === chatId);

    for (const [label, before, args] of [
      ["when the mode changes", [], []],
      ["when the mode didn't change", ["@examplenews"], []],
      ["with --off", ["@examplenews"], ["--off"]],
    ] as const) {
      it(`deletes them ${label}, so the daemon retries them`, async () => {
        if (before.length > 0) await sync(...before);
        failJobs(CHANNEL_PEER_ID, 2);
        failJobs(GROUP_PEER_ID, 1);

        const result = await sync("@examplenews", ...args);

        expect(result.data.clearedFailedJobs).toBe(2);
        expect(result.data.changed).toBe(before.length === 0 || args.length > 0);
        expect(failedOf(CHANNEL_PEER_ID)).toEqual([]);
        expect(failedOf(GROUP_PEER_ID)).toHaveLength(1);
      });
    }
  });

  it("goes back to the default policy with --auto", async () => {
    await sync("@examplenews");
    await sync(String(GROUP_PEER_ID), "--off");

    const channel = await sync("@examplenews", "--auto");
    const group = await sync(String(GROUP_PEER_ID), "--auto");

    expect(channel.data).toMatchObject({
      mode: "auto",
      syncEnabled: false,
      syncReason: "channel",
    });
    expect(stateOf(CHANNEL_PEER_ID)).toMatchObject({
      sync_mode: "auto",
      sync_enabled: 0,
      sync_priority: SyncPriority.Low,
    });
    expect(group.data).toMatchObject({
      mode: "auto",
      syncEnabled: false,
      syncReason: "group_participation_unknown",
    });
    expect(stateOf(GROUP_PEER_ID)).toMatchObject({
      sync_enabled: 1,
      sync_priority: SyncPriority.Medium,
    });
  });

  it("shows in tg chats list why each chat syncs or not (#131)", async () => {
    const bot = fakeDialog({ kind: "user", id: 5001, title: "Example Bot" });
    createChatsCache(cacheDb).upsert(dialogToCacheInput(bot));
    const chatSyncState = createChatSyncStateService(cacheDb);
    chatSyncState.upsert({
      chat_id: 5001,
      chat_type: "private",
      sync_priority: SyncPriority.Medium,
      sync_enabled: true,
      sync_policy: "bot",
    });
    chatSyncState.upsert({
      chat_id: GROUP_PEER_ID,
      chat_type: "group",
      member_count: 50,
      sync_priority: SyncPriority.Medium,
      sync_enabled: true,
      sync_policy: "medium_group",
    });
    await sync("@examplenews");

    const list = await runCliSuccess(["chats", "list"], options());
    const items = (
      list.json as {
        data: {
          items: Array<{
            id: number;
            syncEnabled: boolean;
            syncReason: string | null;
          }>;
        };
      }
    ).data.items;
    const syncOf = (id: number) => {
      const item = items.find((chat) => chat.id === id);
      return [item?.syncEnabled, item?.syncReason];
    };
    expect(syncOf(5001)).toEqual([true, "bot"]);
    expect(syncOf(GROUP_PEER_ID)).toEqual([false, "group_participation_unknown"]);
    expect(syncOf(CHANNEL_PEER_ID)).toEqual([true, "on_by_hand"]);

    takePartIn(cacheDb, GROUP_PEER_ID);
    const again = await runCliSuccess(["chats", "list"], options());
    const group = (
      again.json as {
        data: { items: Array<{ id: number; lastOwnMessageAt: number | null }> };
      }
    ).data.items.find((chat) => chat.id === GROUP_PEER_ID);
    expect(group).toMatchObject({
      syncEnabled: true,
      syncReason: "medium_group",
    });
    expect(group?.lastOwnMessageAt).toBeGreaterThan(Date.now() - 60_000);

    expect((await sync("5001")).data.syncReason).toBe("on_by_hand");
    expect((await sync("5001", "--off")).data.syncReason).toBe("off_by_hand");
    expect((await sync("5001", "--auto")).data).toMatchObject({
      syncEnabled: true,
      syncReason: "bot",
    });
    expect(stateOf(5001)?.sync_priority).toBe(SyncPriority.Medium);
  });

  it("finds a chat the daemon saw only live, a DM before the basic group of its number", async () => {
    const states = createChatSyncStateService(cacheDb);
    states.upsert({
      chat_id: -1009876543210,
      chat_type: "supergroup",
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    });
    states.upsert({
      chat_id: GROUP_ID,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    });

    const supergroup = await sync("-1009876543210");
    const dm = await sync(String(GROUP_ID), "--off");

    expect(supergroup.data).toMatchObject({
      id: -1009876543210,
      peerId: -1009876543210,
      type: "supergroup",
      title: null,
      mode: "on",
      syncEnabled: false,
      syncReason: "group_participation_unknown",
    });
    expect(dm.data).toMatchObject({
      id: GROUP_ID,
      peerId: GROUP_ID,
      type: "private",
      mode: "off",
    });
    expect(stateOf(GROUP_PEER_ID)).toBeNull();
  });

  it("takes a marked ID from tg chats list before --format pretty", async () => {
    const result = await runCliSuccess(
      ["chats", "sync", String(CHANNEL_PEER_ID), "--format", "pretty"],
      options(),
    );

    expect(result.json).toMatchObject({
      id: CHANNEL_PEER_ID,
      title: "Example News",
      mode: "on",
    });
    expect(stateOf(CHANNEL_PEER_ID)).toMatchObject({ sync_mode: "on" });
  });

  it("rejects --off together with --auto", async () => {
    const result = await runCliFailure(
      ["chats", "sync", "@examplenews", "--off", "--auto"],
      3,
      options(),
    );

    expect(result.json).toMatchObject({
      success: false,
      error: { code: "INVALID_ARGS" },
    });
    expect(stateOf(CHANNEL_PEER_ID)).toBeNull();
  });

  it("rejects a missing chat", async () => {
    const result = await runCliFailure(["chats", "sync"], 3, options());

    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: "INVALID_ARGS",
        message: "Missing chat: pass @username or a chat ID",
      },
    });
  });

  it("rejects a chat that is not in the cache", async () => {
    const result = await runCliFailure(["chats", "sync", "@unknownchat"], 3, options());

    expect(result.json).toEqual({
      success: false,
      error: {
        code: "INVALID_ARGS",
        message: "Chat not found in the cache: @unknownchat",
        details: { chat: "@unknownchat", account_id: 1 },
        suggestion:
          "Start the daemon (its dialog pass lists every chat, archived ones too) or run tg chats get --id @username, then retry",
        retryable: false,
      },
    });
  });

  it("refuses to turn on a community and points at its linked chats", async () => {
    const communityId = -1005555555555;
    createChatsCache(cacheDb).upsertMany([
      rawChatToCacheInput(
        fakeRawCommunity({
          id: 5555555555,
          title: "Example Community",
          accessHash: "777",
        }),
      ),
    ]);

    const result = await runCliFailure(["chats", "sync", String(communityId)], 3, options());

    const failure = result.json as {
      error: {
        code: string;
        message: string;
        details: { type: string; id: number };
        suggestion: string;
      };
    };
    expect(failure.error.code).toBe("INVALID_ARGS");
    expect(failure.error.message).toContain("community");
    expect(failure.error.details).toMatchObject({
      type: "community",
      id: communityId,
    });
    expect(failure.error.suggestion).toContain("linked chats");
    expect(stateOf(communityId)).toBeNull();
    expect(cacheDb.query("SELECT COUNT(*) AS n FROM sync_jobs").get()).toEqual({
      n: 0,
    });

    const off = await sync(String(communityId), "--off");
    expect(off.data).toMatchObject({ type: "community", syncEnabled: false });
  });

  it("tells how to turn off a community an earlier version turned on", async () => {
    const communityId = -1005555555555;
    createChatsCache(cacheDb).upsertMany([
      rawChatToCacheInput(fakeRawCommunity({ id: 5555555555, accessHash: "777" })),
    ]);
    const states = createChatSyncStateService(cacheDb);
    states.upsert({
      chat_id: communityId,
      chat_type: "community",
      member_count: null,
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
    });
    states.setSyncMode(communityId, "on");
    const jobs = createSyncJobsService(cacheDb);
    const job = jobs.create({
      chat_id: communityId,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.Low,
    });
    jobs.markRunning(job.id);
    jobs.markFailed(job.id, "Telegram API error 400: CHANNEL_INVALID");

    const result = await runCliFailure(["chats", "sync", String(communityId)], 3, options());
    const suggestion = (result.json as { error: { suggestion: string } }).error.suggestion;
    expect(suggestion).toContain(`tg chats sync ${communityId} --auto`);

    const auto = await sync(String(communityId), "--auto");
    expect(auto.data).toMatchObject({
      mode: "auto",
      syncEnabled: false,
      clearedFailedJobs: 1,
    });
  });
});
