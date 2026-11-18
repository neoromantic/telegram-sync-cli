import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { TelegramClient } from "@mtcute/bun";
import { fakeDialog } from "../__tests__/helpers/fake-dialogs";
import { takePartIn } from "../__tests__/helpers/participation";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { fetchMessagesRaw } from "../daemon/sync-worker-real-helpers";
import { createChatsCache } from "../db/chats-cache";
import { createUsersCache } from "../db/users-cache";
import { wrapClientCallWithRecordReplay } from "../utils/telegram-record-replay";
import { runCliSuccess } from "./helpers/cli";
import { createTestEnvironment, type TestEnvironment } from "./helpers/setup";

const GROUP_ID = -4101;
const ALICE_ID = 7101;

describe("E2E: groups the account does not take part in", () => {
  let env: TestEnvironment;
  let fixturesDir: string;

  beforeEach(() => {
    env = createTestEnvironment("group-participation");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", is_active: true }]);
    fixturesDir = join(env.dataDir, "fixtures");
    const cacheDb = env.openCacheDb(1);
    createChatsCache(cacheDb).upsert(
      dialogToCacheInput(
        fakeDialog({
          kind: "group",
          id: 4101,
          title: "Made-up Hiking Club",
          membersCount: 12,
        }),
      ),
    );
    createUsersCache(cacheDb).upsert({
      user_id: String(ALICE_ID),
      first_name: "Alice",
      last_name: null,
      username: "alice_example",
      access_hash: "1",
      fetched_at: Date.now(),
      raw_json: "{}",
    });
  });

  afterEach(() => {
    env.cleanup();
  });

  async function recordNewestPage(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const messages = [3, 2, 1].map((id) => ({
      _: "message",
      id,
      date: now - 60 * id,
      peerId: { _: "peerChat", chatId: -GROUP_ID },
      fromId: { _: "peerUser", userId: ALICE_ID },
      message: `made-up trail note ${id}`,
    }));
    const client = wrapClientCallWithRecordReplay(
      {
        call: async () => ({
          _: "messages.messages",
          messages,
          chats: [],
          users: [],
        }),
      } as unknown as TelegramClient,
      { accountId: 1, config: { mode: "record", fixturesDir } },
    );
    await fetchMessagesRaw(client, { _: "inputPeerChat", chatId: -GROUP_ID }, { limit: 20 });
  }

  function replayOptions() {
    return {
      env: {
        ...env.getCliOptions().env,
        TELEGRAM_API_REPLAY: "1",
        TELEGRAM_API_FIXTURES_DIR: fixturesDir,
        MTCUTE_LOG_LEVEL: undefined,
        VERBOSE: undefined,
      },
    };
  }

  function cachedCount(): number {
    return (
      env.openCacheDb(1).query("SELECT COUNT(*) AS n FROM messages_cache").get() as { n: number }
    ).n;
  }

  it("shows the page with --fresh, and caches it once the account took part", async () => {
    await recordNewestPage();
    const args = ["messages", "list", "--chat", String(GROUP_ID), "--fresh"];

    const result = await runCliSuccess(args, replayOptions());

    const data = (
      result.json as {
        data: {
          source: string;
          items: Array<{ messageId: number; text: string; chat: unknown }>;
        };
      }
    ).data;
    expect(data.source).toBe("api");
    expect(data.items.map((item) => item.messageId)).toEqual([3, 2, 1]);
    expect(data.items[0]).toMatchObject({
      text: "made-up trail note 3",
      chat: { id: GROUP_ID, title: "Made-up Hiking Club", type: "group" },
      sender: { username: "alice_example" },
    });
    expect(cachedCount()).toBe(0);
    expect(env.openCacheDb(1).query("SELECT COUNT(*) AS n FROM history_ranges").get()).toEqual({
      n: 0,
    });

    takePartIn(env.openCacheDb(1), GROUP_ID);
    await runCliSuccess(args, replayOptions());
    expect(cachedCount()).toBe(3);
  });
});
