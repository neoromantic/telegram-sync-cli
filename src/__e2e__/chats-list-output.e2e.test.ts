import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chatsListOutput } from "../commands/chats/list-output";
import { createChatSyncStateService } from "../db/chat-sync-state";
import type { CachedChatInput } from "../db/chats-cache";
import { createChatsCache } from "../db/chats-cache";
import { SyncPriority } from "../db/sync-schema";
import { NO_CREDENTIALS, runCliSuccess } from "./helpers/cli";
import { createTestEnvironment, type TestEnvironment } from "./helpers/setup";

function chat(input: Pick<CachedChatInput, "chat_id" | "type"> & Partial<CachedChatInput>) {
  return {
    title: null,
    username: null,
    member_count: null,
    access_hash: null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: Date.now(),
    raw_json: "{}",
    ...input,
  };
}

describe("E2E: tg chats list output", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("chats-list-output");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", is_active: true }]);
    const cacheDb = env.openCacheDb(1);
    createChatsCache(cacheDb).upsertMany([
      chat({
        chat_id: "100",
        type: "private",
        title: "Alice Example",
        username: "alice_example",
        last_message_at: 1700000300000,
        unread_count: 2,
        read_inbox_max_id: 10,
      }),
      chat({
        chat_id: "-200",
        type: "group",
        title: "Book Club",
        member_count: 12,
        is_admin: 1,
      }),
      chat({
        chat_id: "-1000000000300",
        type: "supergroup",
        title: "Example Devs",
        username: "exampledevs",
        member_count: 450,
        is_creator: 1,
        is_admin: 1,
      }),
      chat({
        chat_id: "-1000000000400",
        type: "channel",
        title: "Example News",
      }),
      chat({ chat_id: "-1000000000500", type: "community" }),
    ]);
    const chatSyncState = createChatSyncStateService(cacheDb);
    chatSyncState.upsert({
      chat_id: 100,
      chat_type: "private",
      sync_priority: SyncPriority.High,
      sync_enabled: true,
      sync_policy: "dm",
    });
    chatSyncState.upsert({
      chat_id: -1000000000400,
      chat_type: "channel",
      sync_priority: SyncPriority.Low,
      sync_enabled: false,
      sync_policy: "channel",
    });
  });

  afterEach(() => {
    env.cleanup();
  });

  it("prints exactly the declared fields and types", async () => {
    const result = await runCliSuccess(["chats", "list"], {
      env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
    });
    const { data } = result.json as { data: unknown };

    const parsed = chatsListOutput.safeParse(data);
    const issues = (parsed.error?.issues ?? []).map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    expect(issues).toEqual([]);
    expect(parsed.data?.items).toHaveLength(5);
  });
});
