import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { fakeDialog } from "../__tests__/helpers/fake-dialogs";
import { takePartIn } from "../__tests__/helpers/participation";
import { dialogToCacheInput } from "../commands/chats/helpers";
import type { UnreadResult } from "../commands/messages/read-state";
import { parseRawMessage } from "../daemon/sync-worker-real-helpers";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import { toPeerIdFromRawPeer } from "../utils/telegram-peer-ids";
import { type CliOptions, NO_CREDENTIALS, runCli } from "./helpers/cli";
import { FAKE_CLIENT_CALL, FAKE_CLIENT_CLI, FAKE_TOP_MESSAGE } from "./helpers/fake-client-cli";
import { createTestEnvironment, type TestEnvironment } from "./helpers/setup";

const ALICE_ID = 10;
const BOOK_CLUB_ID = -4242;
const TEAM_ID = -1001234567890;
const NEWS_ID = -1002222222222;

const ALICE_PEER = { _: "peerUser", userId: 10 } as const;
const TEAM_PEER = { _: "peerChannel", channelId: 1234567890 } as const;
const NEWS_PEER = { _: "peerChannel", channelId: 2222222222 } as const;

function message(
  peer: typeof ALICE_PEER | typeof TEAM_PEER | typeof NEWS_PEER,
  id: number,
  out = false,
) {
  const from = out ? { fromId: { _: "peerUser", userId: 999 } } : {};
  return parseRawMessage(
    {
      _: "message",
      id,
      out,
      peerId: peer,
      ...from,
      message: `message ${id}`,
      date: 1_760_000_000 + id * 60,
    },
    toPeerIdFromRawPeer(peer) as number,
  ) as NonNullable<ReturnType<typeof parseRawMessage>>;
}

function seed(db: Database): void {
  createUsersCache(db).upsert({
    user_id: "10",
    username: "alice",
    first_name: "Alice",
    last_name: null,
    access_hash: "777",
    fetched_at: Date.now(),
    raw_json: "{}",
  });
  createChatsCache(db).upsertMany(
    [
      fakeDialog({
        kind: "user",
        id: 10,
        title: "Alice",
        username: "alice",
        topMessage: 14,
        unreadCount: 3,
        readInboxMaxId: 11,
        lastMessage: { id: 14, date: 1_760_000_900 },
      }),
      fakeDialog({
        kind: "supergroup",
        id: 1234567890,
        title: "Team Chat",
        username: "teamchat",
        topMessage: 25,
        unreadCount: 5,
        readInboxMaxId: 20,
        lastMessage: { id: 25, date: 1_760_000_800 },
      }),
      fakeDialog({
        kind: "channel",
        id: 2222222222,
        title: "Example News",
        topMessage: 9,
        unreadCount: 0,
        readInboxMaxId: 9,
        lastMessage: { id: 9, date: 1_760_000_700 },
      }),
      fakeDialog({
        kind: "group",
        id: 4242,
        title: "Book Club",
        topMessage: 3,
        unreadCount: 1,
        readInboxMaxId: 2,
        lastMessage: { id: 3, date: 1_760_000_100 },
      }),
    ].map(dialogToCacheInput),
  );
  takePartIn(db, BOOK_CLUB_ID, TEAM_ID);
  createMessagesCache(db).upsertBatch([
    message(ALICE_PEER, 10),
    message(ALICE_PEER, 11),
    message(ALICE_PEER, 12),
    message(ALICE_PEER, 13, true),
    message(ALICE_PEER, 14),
    message(ALICE_PEER, 15),
    message(TEAM_PEER, 24),
    message(TEAM_PEER, 25),
    message(NEWS_PEER, 9),
  ]);
}

interface ChatListData {
  items: Array<{ id: number; unreadCount: number | null }>;
  total: number;
  source: string;
}

describe("E2E: unread messages", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("unread");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: 999, is_active: true }]);
    seed(env.openCacheDb(1));
  });

  afterEach(() => {
    env.cleanup();
  });

  const offline = (): CliOptions => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  });
  const fake = (): CliOptions => ({
    ...env.getCliOptions(),
    entry: FAKE_CLIENT_CLI,
  });

  async function data<T>(args: string[], options: CliOptions): Promise<T> {
    const result = await runCli(args, options);
    expect(result.exitCode).toBe(0);
    return (result.json as { data: T }).data;
  }

  it("lists only chats with unread messages, newest first, with the count", async () => {
    const list = await data<ChatListData>(["chats", "list", "--unread"], offline());

    expect(list.items.map((item) => [item.id, item.unreadCount])).toEqual([
      [ALICE_ID, 3],
      [TEAM_ID, 5],
      [BOOK_CLUB_ID, 1],
    ]);
    expect(list).toMatchObject({ total: 3, source: "cache" });

    const all = await data<ChatListData>(["chats", "list"], offline());
    expect(all.items.find((item) => item.id === NEWS_ID)?.unreadCount).toBe(0);
  });

  it("prints the unread messages of every chat from the cache", async () => {
    const unread = await data<UnreadResult>(["messages", "unread", "--limit", "2"], offline());

    expect(
      unread.chats.map((chat) => ({
        id: chat.chat.id,
        ids: chat.items.map((item) => item.messageId),
        unreadCount: chat.unreadCount,
        missing: chat.missing,
      })),
    ).toEqual([
      { id: ALICE_ID, ids: [14, 12], unreadCount: 3, missing: 0 },
      { id: TEAM_ID, ids: [25, 24], unreadCount: 5, missing: 3 },
      { id: BOOK_CLUB_ID, ids: [], unreadCount: 1, missing: 1 },
    ]);
    expect(unread.chats[0]).toMatchObject({
      chat: {
        id: ALICE_ID,
        title: "Alice",
        username: "alice",
        type: "private",
      },
      readInboxMaxId: 11,
      returned: 2,
      nextAfter: 14,
      source: "cache",
    });
    expect(unread).toMatchObject({
      unreadCount: 9,
      missing: 4,
      returned: 4,
      limit: 2,
      source: "cache",
      stale: false,
    });
  });

  it("prints the unread messages of one chat", async () => {
    const unread = await data<UnreadResult>(["messages", "unread", "--chat", "@alice"], offline());

    expect(unread.chats).toHaveLength(1);
    expect(unread.chats[0]?.items.map((item) => item.messageId)).toEqual([15, 14, 12]);
  });

  it("needs Telegram for --fresh and to mark read", async () => {
    for (const args of [
      ["messages", "unread", "--fresh"],
      ["messages", "unread", "--chat", "@teamchat", "--fresh"],
      ["messages", "read", "--chat", "@alice"],
    ]) {
      const result = await runCli(args, offline());
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("TELEGRAM_API_ID");
    }
  });

  it("refuses a --max-id that is not a message ID", async () => {
    const result = await runCli(
      ["messages", "read", "--chat", "@alice", "--max-id", "5abc"],
      offline(),
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Invalid --max-id: 5abc");
  });

  it.each([
    ["private chat", "@alice", ALICE_ID, "messages.readHistory"],
    ["basic group", String(BOOK_CLUB_ID), BOOK_CLUB_ID, "messages.readHistory"],
    ["supergroup", "@teamchat", TEAM_ID, "channels.readHistory"],
    ["channel", String(NEWS_ID), NEWS_ID, "channels.readHistory"],
  ])("marks a whole %s read and updates its cached count", async (_kind, chat, chatId, method) => {
    const result = await runCli(["messages", "read", "--chat", chat], fake());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`${FAKE_CLIENT_CALL} ${JSON.stringify({ method, maxId: 0 })}`);
    expect((result.json as { data: unknown }).data).toEqual({
      chatId,
      maxId: null,
      method,
      unreadCount: 0,
      readInboxMaxId: FAKE_TOP_MESSAGE,
    });

    const list = await data<ChatListData>(["chats", "list", "--unread"], offline());
    expect(list.items.map((item) => item.id)).not.toContain(chatId);
  });

  it("marks read up to --max-id", async () => {
    const result = await runCli(["messages", "read", "--chat", "@alice", "--max-id", "12"], fake());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "messages.readHistory", maxId: 12 })}`,
    );
    expect((result.json as { data: unknown }).data).toMatchObject({
      maxId: 12,
      readInboxMaxId: 12,
      unreadCount: FAKE_TOP_MESSAGE - 12,
    });

    const unread = await data<UnreadResult>(["messages", "unread", "--chat", "@alice"], offline());
    expect(unread.chats[0]?.items.map((item) => item.messageId)).toEqual([15, 14]);
  });
});
