import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { fakeDialog } from "../__tests__/helpers/fake-dialogs";
import { LEGACY } from "../__tests__/helpers/legacy-cache";
import { videoMessage } from "../__tests__/helpers/media-messages";
import { takePartIn } from "../__tests__/helpers/participation";
import { assertPeerIdInvariants } from "../__tests__/helpers/peer-id-invariants";
import { photoMessage } from "../__tests__/helpers/photo-message";
import {
  cell,
  plain,
  REPORT_BLOCKS,
  REPORT_TEXT,
  richTlMessage,
} from "../__tests__/helpers/rich-message";
import { seedInChild } from "../__tests__/helpers/seed-in-child";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { parseRawMessage } from "../daemon/sync-worker-real-helpers";
import { createChatsCache } from "../db/chats-cache";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { PEER_ID_USER_VERSION } from "../db/peer-id-migration";
import { createUsersCache } from "../db/users-cache";
import type { MessageSearchItem } from "../types";
import { extractAttachment } from "../utils/attachment";
import { toRawJson } from "../utils/raw-json";
import { toPeerIdFromRawPeer } from "../utils/telegram-peer-ids";
import { NO_CREDENTIALS, runCli, runCliSuccess } from "./helpers/cli";
import { createTestEnvironment, type TestEnvironment } from "./helpers/setup";

describe("E2E: Messages Search", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("messages-search");
    env.initDatabase();
    env.seedAccounts([{ phone: "+1111111111", name: "Test Account", is_active: true }]);

    seedCacheData(env.openCacheDb(1));
  });

  afterEach(() => {
    env.cleanup();
  });

  it("filters by chat and sender", async () => {
    const result = await runCliSuccess(
      ["messages", "search", "--query", "hello", "--chat", "@teamchat", "--sender", "@alice"],
      env.getCliOptions(),
    );

    const response = result.json as {
      success: boolean;
      data: {
        results: Array<{
          messageId: number;
          chat: { username: string | null };
          sender: { username: string | null };
        }>;
        total: number;
      };
    };

    expect(response.success).toBe(true);
    expect(response.data.total).toBe(1);
    expect(response.data.results[0]?.messageId).toBe(1);
    expect(response.data.results[0]?.chat.username).toBe("teamchat");
    expect(response.data.results[0]?.sender.username).toBe("alice");
  });

  it("includes deleted messages when requested", async () => {
    const result = await runCliSuccess(
      ["messages", "search", "--query", "hello", "--chat", "@teamchat", "--includeDeleted"],
      env.getCliOptions(),
    );

    const response = result.json as {
      success: boolean;
      data: {
        results: Array<{ messageId: number; isDeleted: boolean }>;
        total: number;
        filters: { includeDeleted: boolean };
      };
    };

    const messageIds = response.data.results.map((row) => row.messageId).sort();

    expect(response.success).toBe(true);
    expect(response.data.filters.includeDeleted).toBe(true);
    expect(response.data.total).toBe(2);
    expect(messageIds).toEqual([1, 2]);
  });

  async function search(...args: string[]) {
    const result = await runCliSuccess(["messages", "search", ...args], env.getCliOptions());
    return (result.json as { data: { results: MessageSearchItem[] } }).data.results;
  }

  it("returns the chat of a supergroup message", async () => {
    const results = await search("--query", "hello");
    const hit = results.find((item) => item.chatId === TEAM_CHAT_ID);

    expect(hit?.chat).toEqual({
      id: TEAM_CHAT_ID,
      title: "Team Chat",
      username: "teamchat",
      type: "supergroup",
    });

    const filtered = await search("--query", "hello", "--chat", "@teamchat");
    expect(filtered.map((item) => [item.chatId, item.messageId])).toEqual([[TEAM_CHAT_ID, 1]]);
  });

  it("gives every result its chat title and type", async () => {
    const results = await search("--query", "hello");

    expect(results.map((item) => [item.chatId, item.chat.type])).toEqual([
      [ALICE_ID, "private"],
      [NEWS_ID, "channel"],
      [BOOK_CLUB_ID, "group"],
      [TEAM_CHAT_ID, "supergroup"],
    ]);
    for (const item of results) {
      expect(item.chat.title).toEqual(expect.any(String));
    }
    const fromAlice = results.filter((item) => item.fromId === ALICE_ID);
    expect(fromAlice.map((item) => item.sender.firstName)).toEqual(["Alice", "Alice"]);
    expect(results.find((item) => item.chatId === NEWS_ID)?.fromId).toBe(NEWS_ID);
  });

  it("prints each chat under the ID that tg chats list prints", async () => {
    const list = await runCliSuccess(["chats", "list"], env.getCliOptions());
    const listed = (list.json as { data: { items: Array<{ id: number; type: string }> } }).data
      .items;
    const results = await search("--query", "hello");

    expect(listed.map((chat) => chat.type).sort()).toEqual([
      "channel",
      "group",
      "private",
      "supergroup",
    ]);
    for (const chat of listed) {
      const hit = results.find((item) => item.chat.type === chat.type);
      expect([hit?.chatId, hit?.chat.id]).toEqual([chat.id, chat.id]);
    }
  });

  it("finds a message by the title of its chat", async () => {
    const results = await search("--query", "Book Club");

    expect(results.map((item) => [item.chatId, item.text])).toEqual([[BOOK_CLUB_ID, "hello club"]]);
  });

  it("leaves the cache in one peer ID format", async () => {
    await search("--query", "hello");

    assertPeerIdInvariants(env.openCacheDb(1));
  });
});

describe("E2E: Messages Search on a cache from 0.2.0", () => {
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment("messages-search-legacy");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", name: "Test Account", is_active: true }]);
    seedInChild(join(env.dataDir, "cache.db"), "legacySharedCache");
  });

  afterAll(() => {
    env.cleanup();
  });

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  });

  async function search(query: string) {
    const result = await runCliSuccess(["messages", "search", "--query", query], options());
    return (result.json as { data: { results: MessageSearchItem[] } }).data.results;
  }

  it("shows group and channel titles on the first run", async () => {
    const results = await search("hello");

    expect(results.map((item) => [item.chatId, item.chat.title, item.chat.type])).toEqual(
      expect.arrayContaining([
        [LEGACY.teamChat.marked, "Team Chat", "supergroup"],
        [LEGACY.bookClub.marked, "Book Club", "group"],
        [LEGACY.news.marked, "Example News", "channel"],
        [LEGACY.alice.id, "Alice Able", "private"],
      ]),
    );
    expect(results).toHaveLength(4);
  });

  it("lists the chats under their marked IDs", async () => {
    const list = await runCliSuccess(["chats", "list"], options());
    const ids = (list.json as { data: { items: Array<{ id: number }> } }).data.items;

    expect(ids.map((chat) => chat.id).sort()).toEqual(
      [LEGACY.alice.id, LEGACY.teamChat.marked, LEGACY.bookClub.marked, LEGACY.news.marked].sort(),
    );
  });

  it("finds a message by the title of its chat", async () => {
    const results = await search("Team Chat");

    expect(results.map((item) => item.text)).toEqual(["weekly digest is out", "hello team"]);
  });

  it("prints a channel that posts as itself under its marked ID", async () => {
    const [hit] = await search("weekly digest");

    expect(hit).toMatchObject({
      fromId: LEGACY.senderChannel.marked,
      sender: { id: LEGACY.senderChannel.marked, firstName: null },
    });
  });

  it("joins every cached message to its chat in SQL", async () => {
    const result = await runCliSuccess(
      [
        "sql",
        "--query",
        "SELECT COUNT(DISTINCT m.chat_id) AS orphans FROM messages_cache m LEFT JOIN chats_cache c ON c.chat_id = CAST(m.chat_id AS TEXT) WHERE c.chat_id IS NULL",
      ],
      options(),
    );

    expect(result.json).toMatchObject({ data: { rows: [{ orphans: 0 }] } });
    expect(existsSync(join(env.dataDir, "cache.db"))).toBe(false);

    const db = new Database(env.cachePath(1));
    try {
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: PEER_ID_USER_VERSION,
      });
      assertPeerIdInvariants(db);
    } finally {
      db.close();
    }
  });
});

const TEAM_CHAT_PEER = { _: "peerChannel", channelId: 1234567890 } as const;
const BOOK_CLUB_PEER = { _: "peerChat", chatId: 4242 } as const;
const NEWS_PEER = { _: "peerChannel", channelId: 2222222222 } as const;
const ALICE_PEER = { _: "peerUser", userId: 10 } as const;
const BOB_PEER = { _: "peerUser", userId: 11 } as const;

function syncedMessage(
  peer: Parameters<typeof toPeerIdFromRawPeer>[0] & object,
  id: number,
  text: string,
  from?: typeof ALICE_PEER | typeof BOB_PEER,
) {
  return parseRawMessage(
    {
      _: "message",
      id,
      peerId: peer,
      ...(from ? { fromId: from } : {}),
      message: text,
      date: Math.floor(Date.now() / 1000) - 3600 + id * 60,
    },
    toPeerIdFromRawPeer(peer)!,
  )!;
}

function seedCacheData(db: Database) {
  const now = Date.now();
  const usersCache = createUsersCache(db);

  usersCache.upsert({
    user_id: "10",
    username: "alice",
    first_name: "Alice",
    last_name: "Able",
    fetched_at: now,
    raw_json: "{}",
  });

  usersCache.upsert({
    user_id: "11",
    username: "bob",
    first_name: "Bob",
    last_name: "Baker",
    fetched_at: now,
    raw_json: "{}",
  });

  createChatsCache(db).upsertMany(
    [
      fakeDialog({
        kind: "supergroup",
        id: 1234567890,
        title: "Team Chat",
        username: "teamchat",
        membersCount: 3,
      }),
      fakeDialog({ kind: "group", id: 4242, title: "Book Club" }),
      fakeDialog({
        kind: "channel",
        id: 2222222222,
        title: "Example News",
        username: "examplenews",
      }),
      fakeDialog({ kind: "user", id: 10, title: "Alice Able" }),
    ].map(dialogToCacheInput),
  );

  takePartIn(db, -4242, -1001234567890);

  createMessagesCache(db).upsertBatch([
    syncedMessage(TEAM_CHAT_PEER, 1, "hello team", ALICE_PEER),
    {
      ...syncedMessage(TEAM_CHAT_PEER, 2, "hello deleted", BOB_PEER),
      is_deleted: true,
    },
    syncedMessage(BOOK_CLUB_PEER, 3, "hello club", BOB_PEER),
    syncedMessage(NEWS_PEER, 4, "hello subscribers"),
    syncedMessage(ALICE_PEER, 5, "hello from Alice"),
  ]);
}

interface ListData {
  chatId: number;
  items: MessageSearchItem[];
  limit: number;
  before: number | null;
  after: number | null;
  nextBefore: number | null;
  nextAfter: number | null;
  source: "cache" | "api";
  stale: boolean;
}

interface ErrorData {
  success: false;
  error: { code: string; message: string };
}

const SELF_ID = 999;
const SECOND_SELF_ID = 998;
const SECOND_ACCOUNT_ID = 2;
const ALICE_ID = 10;
const TEAM_CHAT_ID = -1001234567890;
const BOOK_CLUB_ID = -4242;
const NEWS_ID = -1002222222222;
const BOB_ID = 11;
const NEW_DM_ID = 7_000_000_001;

function useSeededHistory(name: string) {
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment(name);
    env.initDatabase();
    env.seedAccounts([
      {
        phone: "+15550000000",
        user_id: SELF_ID,
        name: "Test Account",
        is_active: true,
      },
      {
        phone: "+15550000001",
        user_id: SECOND_SELF_ID,
        name: "Second Account",
        is_active: false,
      },
    ]);

    seedHistory(env.openCacheDb(1));
    seedSecondAccount(env.openCacheDb(SECOND_ACCOUNT_ID));
  });

  afterAll(() => {
    env.cleanup();
  });

  return () => ({ env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } });
}

describe("E2E: Messages List", () => {
  const options = useSeededHistory("messages-list");

  async function list(...args: string[]) {
    const result = await runCliSuccess(["messages", "list", ...args], options());
    return (result.json as { data: ListData }).data;
  }

  async function ids(...args: string[]) {
    return (await list(...args)).items.map((item) => item.messageId);
  }

  async function listFailure(...args: string[]) {
    const result = await runCli(["messages", "list", ...args], options());
    return { exitCode: result.exitCode, json: result.json as ErrorData };
  }

  it("returns the newest page from the cache, newest first", async () => {
    const data = await list("--chat", "@alice", "--limit", "3");

    expect(data.items.map((item) => item.messageId)).toEqual([7, 6, 5]);
    expect(data).toMatchObject({
      chatId: ALICE_ID,
      limit: 3,
      before: null,
      after: null,
      nextBefore: 5,
      nextAfter: 7,
      source: "cache",
      stale: false,
    });
  });

  it("pages back with --before until the page is empty", async () => {
    const pages = [await ids("--chat", "@alice", "--limit", "3")];
    let data = await list("--chat", "@alice", "--limit", "3", "--before", "5");
    pages.push(data.items.map((item) => item.messageId));
    expect(pages[1]).toEqual([4, 3, 2]);

    data = await list("--chat", "@alice", "--limit", "3", "--before", String(data.nextBefore));
    pages.push(data.items.map((item) => item.messageId));
    expect(pages[2]).toEqual([1]);

    const end = await list("--chat", "@alice", "--limit", "3", "--before", "1");
    expect(end.items).toEqual([]);
    expect(end.source).toBe("cache");
    expect(end.nextBefore).toBeNull();

    expect(pages.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("pages forward with --after, starting at 0", async () => {
    expect(await ids("--chat", "@alice", "--limit", "3", "--after", "0")).toEqual([3, 2, 1]);
    expect(await ids("--chat", "@alice", "--limit", "3", "--after", "3")).toEqual([6, 5, 4]);
    expect(await ids("--chat", "@alice", "--limit", "3", "--after", "5", "--before", "8")).toEqual([
      7, 6,
    ]);
    expect(await ids("--chat", "@alice", "--limit", "3", "--after", "2", "--before", "6")).toEqual([
      5, 4, 3,
    ]);
  });

  it("asks Telegram when the cache cannot vouch for the window", async () => {
    for (const args of [
      ["--chat", "@alice", "--after", "7"],
      ["--chat", String(NEW_DM_ID)],
    ]) {
      const { exitCode, json } = await listFailure(...args);
      expect(exitCode).toBe(3);
      expect(json.error.code).toBe("INVALID_ARGS");
      expect(json.error.message).toContain("TELEGRAM_API_ID");
    }
  });

  it.each(["+15550001111", "15550001111"])(
    "needs credentials to look up the phone number %p",
    async (chat) => {
      const { exitCode, json } = await listFailure("--chat", chat);
      expect(exitCode).toBe(3);
      expect(json.error.code).toBe("INVALID_ARGS");
      expect(json.error.message).toContain("TELEGRAM_API_ID");
    },
  );

  it("asks Telegram with --fresh even when the cache holds the page", async () => {
    expect((await list("--chat", "@alice")).source).toBe("cache");

    const { exitCode, json } = await listFailure("--chat", "@alice", "--fresh");

    expect(exitCode).toBe(3);
    expect(json.error.code).toBe("INVALID_ARGS");
    expect(json.error.message).toContain("TELEGRAM_API_ID");
  });

  it("reads Saved Messages of the account that --account selects", async () => {
    const data = await list("--chat", "me", "--account", String(SECOND_ACCOUNT_ID));

    expect(data.chatId).toBe(SECOND_SELF_ID);
    expect(data.items.map((item) => item.messageId)).toEqual([5]);
  });

  it("skips deleted messages unless --includeDeleted", async () => {
    expect(await ids("--chat", "@alice")).not.toContain(8);

    const data = await list("--chat", "@alice", "--includeDeleted", "--limit", "3");
    expect(data.items.map((item) => item.messageId)).toEqual([8, 7, 6]);
    expect(data.items[0]?.isDeleted).toBe(true);
  });

  it("accepts every chat form that tg prints", async () => {
    expect((await list("--chat", "10")).chatId).toBe(ALICE_ID);
    expect((await list("--chat", "me")).chatId).toBe(SELF_ID);
    expect(await ids("--chat", "me")).toEqual([2, 1]);

    const byUsername = await list("--chat", "@teamchat");
    expect(byUsername.chatId).toBe(TEAM_CHAT_ID);
    expect(byUsername.items.map((item) => item.messageId)).toEqual([3, 2, 1]);
    for (const chat of ["1234567890", "-1001234567890"]) {
      const data = await list("--chat", chat);
      expect(data.chatId).toBe(TEAM_CHAT_ID);
      expect(data.items).toEqual(byUsername.items);
    }

    const bookClub = await list("--chat", "-4242");
    expect(bookClub.chatId).toBe(BOOK_CLUB_ID);
    expect(bookClub.items.map((item) => item.messageId)).toEqual([1]);

    const bob = await list("--chat", String(BOB_ID));
    expect(bob.chatId).toBe(BOB_ID);
    expect(bob.items.map((item) => item.text)).toEqual(["got the tickets"]);
  });

  it("prints exactly the items that messages search prints", async () => {
    const listed = await list("--chat", "@teamchat");
    const search = await runCliSuccess(["messages", "search", "--query", "pineapple"], options());
    const [hit] = (search.json as { data: { results: MessageSearchItem[] } }).data.results;

    expect(hit).toBeDefined();
    expect(listed.items.find((item) => item.messageId === 2)).toEqual(hit!);
  });

  it.each([
    "--limit 0",
    "--limit 101",
    "--limit 5abc",
    "--before 0",
    "--before abc",
    "--before 2147483648",
    "--after -1",
    "--after 2147483647",
    "--after 5 --before 5",
  ])("rejects %p with INVALID_ARGS", async (flags) => {
    const { exitCode, json } = await listFailure("--chat", "@alice", ...flags.split(" "));
    expect(exitCode).toBe(3);
    expect(json.error.code).toBe("INVALID_ARGS");
    expect(json.error.message).not.toContain("TELEGRAM_API_ID");
    expect(json.error.message).toMatch(
      /^Invalid --(limit|before|after):|must be smaller than --before/,
    );
  });

  it.each(["--chat=", "--chat=-12.5", "--chat=1e1", "--chat=0x10"])(
    "rejects the malformed chat %p with INVALID_ARGS",
    async (flag) => {
      const result = await runCli(["messages", "list", flag], options());
      const json = result.json as ErrorData;

      expect(result.exitCode).toBe(3);
      expect(json.error.code).toBe("INVALID_ARGS");
      expect(json.error.message).toStartWith("Invalid --chat:");
    },
  );

  it("requires --chat", async () => {
    const result = await runCli(["messages", "list"], options());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing required argument");
  });
});

interface GetData {
  chatId: number;
  message: MessageSearchItem;
  newer: MessageSearchItem[];
  older: MessageSearchItem[];
  source: "cache" | "api";
  stale: boolean;
}

describe("E2E: Messages Get", () => {
  const options = useSeededHistory("messages-get");

  async function get(...args: string[]) {
    const result = await runCliSuccess(["messages", "get", ...args], options());
    return (result.json as { data: GetData }).data;
  }

  function ids(items: MessageSearchItem[]) {
    return items.map((item) => item.messageId);
  }

  async function getFailure(...args: string[]) {
    const result = await runCli(["messages", "get", ...args], options());
    return { exitCode: result.exitCode, json: result.json as ErrorData };
  }

  it("returns a message with its context from the cache", async () => {
    const data = await get("--chat", "@alice", "--id", "4", "--context", "2");

    expect(data.message.messageId).toBe(4);
    expect(ids(data.newer)).toEqual([6, 5]);
    expect(ids(data.older)).toEqual([3, 2]);
    expect(data).toMatchObject({
      chatId: ALICE_ID,
      source: "cache",
      stale: false,
    });
  });

  it("serves the context the cache holds when Telegram cannot be asked", async () => {
    const data = await get("--chat", "@alice", "--id", "7", "--context", "2");

    expect(data.message.messageId).toBe(7);
    expect(data.newer).toEqual([]);
    expect(ids(data.older)).toEqual([6, 5]);
    expect(data.source).toBe("cache");
  });

  it("serves no older context for the first message of a chat", async () => {
    const data = await get("--chat", "@alice", "--id", "1", "--context", "2");

    expect(ids(data.newer)).toEqual([3, 2]);
    expect(data.older).toEqual([]);
    expect(data.source).toBe("cache");
  });

  it("includes deleted context with --includeDeleted", async () => {
    const data = await get("--chat", "@alice", "--id", "6", "--context", "2", "--includeDeleted");

    expect(ids(data.newer)).toEqual([8, 7]);
    expect(data.newer[0]?.isDeleted).toBe(true);
    expect(ids(data.older)).toEqual([5, 4]);
    expect(data.source).toBe("cache");
  });

  it("asks Telegram with --fresh even when the message is cached", async () => {
    expect((await get("--chat", "@alice", "--id", "4")).source).toBe("cache");

    const { exitCode, json } = await getFailure("--chat", "@alice", "--id", "4", "--fresh");

    expect(exitCode).toBe(3);
    expect(json.error.code).toBe("INVALID_ARGS");
    expect(json.error.message).toContain("TELEGRAM_API_ID");
  });

  it("reads Saved Messages of the account that --account selects", async () => {
    const data = await get("--chat", "me", "--id", "5", "--account", String(SECOND_ACCOUNT_ID));

    expect(data.chatId).toBe(SECOND_SELF_ID);
    expect(data.message.text).toBe("renew the passport");
  });

  it("returns no context by default", async () => {
    const data = await get("--chat", "@alice", "--id", "4");

    expect(data.message.messageId).toBe(4);
    expect(data.newer).toEqual([]);
    expect(data.older).toEqual([]);
  });

  it("returns a deleted message that is cached", async () => {
    const data = await get("--chat", "@alice", "--id", "8");

    expect(data.message).toMatchObject({ messageId: 8, isDeleted: true });
    expect(data.source).toBe("cache");
  });

  it("prints the same item as tg messages list", async () => {
    const data = await get("--chat", "-1001234567890", "--id", "2");
    const listed = await runCliSuccess(["messages", "list", "--chat", "@teamchat"], options());
    const items = (listed.json as { data: ListData }).data.items;

    expect(data.chatId).toBe(TEAM_CHAT_ID);
    expect(data.message).toEqual(items.find((item) => item.messageId === 2)!);
  });

  it("opens a search hit in a private chat that only the message cache knows", async () => {
    const search = await runCliSuccess(["messages", "search", "--query", "kiwi"], options());
    const [hit] = (search.json as { data: { results: MessageSearchItem[] } }).data.results;
    expect(hit?.chatId).toBe(NEW_DM_ID);

    const data = await get(
      "--chat",
      String(hit!.chatId),
      "--id",
      String(hit!.messageId),
      "--context",
      "5",
    );

    expect(data.chatId).toBe(NEW_DM_ID);
    expect(data.message).toEqual(hit!);
    expect(data.newer).toEqual([]);
    expect(data.older).toEqual([]);
    expect(data.source).toBe("cache");
  });

  it("asks Telegram for a message the cache does not hold", async () => {
    const { exitCode, json } = await getFailure("--chat", "@alice", "--id", "99");

    expect(exitCode).toBe(3);
    expect(json.error.code).toBe("INVALID_ARGS");
    expect(json.error.message).toContain("TELEGRAM_API_ID");
  });

  it.each(["--id 0", "--id abc", "--id 2147483647", "--id 4 --context -1", "--id 4 --context 50"])(
    "rejects %p with INVALID_ARGS",
    async (flags) => {
      const { exitCode, json } = await getFailure("--chat", "@alice", ...flags.split(" "));
      expect(exitCode).toBe(3);
      expect(json.error.code).toBe("INVALID_ARGS");
      expect(json.error.message).not.toContain("TELEGRAM_API_ID");
      expect(json.error.message).toMatch(/^Invalid --(id|context):/);
    },
  );

  it("requires --id", async () => {
    const result = await runCli(["messages", "get", "--chat", "@alice"], options());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Missing required argument");
  });
});

const LAKE_CLUB_RAW_ID = 1_555_000_001;
const LAKE_CLUB_ID = -1_001_555_000_001;

describe("E2E: Message attachments", () => {
  const peerId = { _: "peerChannel" as const, channelId: LAKE_CLUB_RAW_ID };
  const text = {
    _: "message",
    id: 1,
    peerId,
    date: 1_760_000_001,
    message: "welcome to the lake club",
  };
  const photo = photoMessage(peerId, 2);
  const video = { ...videoMessage(peerId, 3), message: "the lake at dawn" };
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment("messages-attachments");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: SELF_ID, is_active: true }]);
    const db = env.openCacheDb(1);
    createChatsCache(db).upsertMany([
      dialogToCacheInput(
        fakeDialog({
          kind: "supergroup",
          id: LAKE_CLUB_RAW_ID,
          title: "Lake Club",
          username: "lakeclub",
        }),
      ),
    ]);
    const [textInput, photoInput, videoInput] = [text, photo, video].map((raw) =>
      parseRawMessage(raw, LAKE_CLUB_ID)!,
    );
    takePartIn(db, LAKE_CLUB_ID);
    createMessagesCache(db).upsertBatch([
      textInput!,
      photoInput!,
      {
        ...videoInput!,
        message_type: "document",
        raw_json: JSON.stringify(video),
      },
    ]);
    db.run("DELETE FROM message_attachments WHERE message_id = 3");
    createHistoryRanges(db).add(LAKE_CLUB_ID, { low: 1, high: 3 });
  });

  afterAll(() => {
    env.cleanup();
  });

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  });

  it("gives every listed message its attachment, older rows included", async () => {
    const result = await runCliSuccess(["messages", "list", "--chat", "@lakeclub"], options());
    const { items, source } = (result.json as { data: ListData }).data;

    expect(source).toBe("cache");
    expect(items.map((item) => [item.messageId, item.attachment])).toEqual([
      [3, extractAttachment(video)],
      [2, extractAttachment(photo)],
      [1, null],
    ]);
    expect(items[0]?.attachment).toMatchObject({
      kind: "video",
      fileName: "example-lake.mp4",
      mimeType: "video/mp4",
      size: 4_000_000,
      duration: 12.5,
      width: 1280,
      height: 720,
    });
  });

  it("gives the message tg messages get prints its attachment", async () => {
    const result = await runCliSuccess(
      ["messages", "get", "--chat", "@lakeclub", "--id", "2", "--context", "1"],
      options(),
    );
    const data = (result.json as { data: GetData }).data;

    expect(data.message.attachment).toEqual(extractAttachment(photo));
    expect(data.newer[0]?.attachment).toEqual(extractAttachment(video));
    expect(data.older[0]?.attachment).toBeNull();
  });

  it("gives every search hit its attachment", async () => {
    const result = await runCliSuccess(
      ["messages", "search", "--query", "lake", "--chat", "@lakeclub"],
      options(),
    );
    const { results } = (result.json as { data: { results: MessageSearchItem[] } }).data;

    expect(results.map((item) => [item.messageId, item.attachment?.kind ?? null]).sort()).toEqual([
      [1, null],
      [2, "photo"],
      [3, "video"],
    ]);
  });
});

const CALLER_ID = 7_000_000_101;
const HARBOR_RAW_ID = 1_555_000_002;
const HARBOR_ID = -1_001_555_000_002;

describe("E2E: Service message actions", () => {
  const callPeer = { _: "peerUser" as const, userId: CALLER_ID };
  const harborPeer = { _: "peerChannel" as const, channelId: HARBOR_RAW_ID };
  const call = (id: number, action: Record<string, unknown>) => ({
    _: "messageService",
    id,
    peerId: callPeer,
    fromId: callPeer,
    date: 1_760_000_000 + id,
    action: {
      _: "messageActionPhoneCall",
      callId: String(9000 + id),
      ...action,
    },
  });
  const calls = [
    call(1, { reason: { _: "phoneCallDiscardReasonHangup" }, duration: 1834 }),
    call(2, {
      video: true,
      reason: { _: "phoneCallDiscardReasonDisconnect" },
      duration: 95,
    }),
    call(3, { reason: { _: "phoneCallDiscardReasonMissed" } }),
  ];
  const harbor = [
    {
      _: "message",
      id: 1,
      peerId: harborPeer,
      date: 1_760_000_101,
      message: "boats leave at nine",
    },
    {
      _: "messageService",
      id: 2,
      peerId: harborPeer,
      date: 1_760_000_102,
      replyTo: { _: "messageReplyHeader", replyToMsgId: 1 },
      action: { _: "messageActionPinMessage" },
    },
    {
      _: "messageService",
      id: 3,
      peerId: harborPeer,
      date: 1_760_000_103,
      action: { _: "messageActionChatEditTitle", title: "Harbor Crew" },
    },
    {
      _: "messageService",
      id: 4,
      peerId: harborPeer,
      date: 1_760_000_104,
      action: { _: "messageActionScreenshotTaken" },
    },
  ];
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment("messages-actions");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: SELF_ID, is_active: true }]);
    const db = env.openCacheDb(1);
    createChatsCache(db).upsertMany([
      dialogToCacheInput(
        fakeDialog({
          kind: "supergroup",
          id: HARBOR_RAW_ID,
          title: "Harbor Crew",
          username: "harborcrew",
        }),
      ),
    ]);
    takePartIn(db, HARBOR_ID);
    const messages = createMessagesCache(db);
    messages.upsertBatch(calls.map((raw) => parseRawMessage(raw, CALLER_ID)!));
    messages.upsertBatch(harbor.map((raw) => parseRawMessage(raw, HARBOR_ID)!));
    createHistoryRanges(db).add(CALLER_ID, { low: 1, high: 3 });
    createHistoryRanges(db).add(HARBOR_ID, { low: 1, high: 4 });
  });

  afterAll(() => {
    env.cleanup();
  });

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  });

  it("says each call was a call, with video, duration and why it ended", async () => {
    const result = await runCliSuccess(
      ["messages", "list", "--chat", String(CALLER_ID)],
      options(),
    );
    const { items, source } = (result.json as { data: ListData }).data;

    expect(source).toBe("cache");
    expect(items.map((item) => [item.messageId, item.messageType])).toEqual([
      [3, "service"],
      [2, "service"],
      [1, "service"],
    ]);
    expect(items.map((item) => item.action)).toEqual([
      { type: "phone_call", video: false, duration: null, reason: "missed" },
      { type: "phone_call", video: true, duration: 95, reason: "disconnect" },
      { type: "phone_call", video: false, duration: 1834, reason: "hangup" },
    ]);
  });

  it("gives pins and group changes their action, and other messages null", async () => {
    const result = await runCliSuccess(
      ["messages", "get", "--chat", "@harborcrew", "--id", "2", "--context", "2"],
      options(),
    );
    const data = (result.json as { data: GetData }).data;

    expect(data.message.action).toEqual({ type: "pin_message", messageId: 1 });
    expect(data.newer.map((item) => item.action)).toEqual([
      { type: "screenshot_taken" },
      { type: "chat_edit_title", title: "Harbor Crew" },
    ]);
    expect(data.older.map((item) => [item.messageId, item.action])).toEqual([[1, null]]);
  });

  it("gives search hits the action key too", async () => {
    const result = await runCliSuccess(
      ["messages", "search", "--query", "boats", "--chat", "@harborcrew"],
      options(),
    );
    const { results } = (result.json as { data: { results: MessageSearchItem[] } }).data;

    expect(results.map((item) => [item.messageId, item.action])).toEqual([[1, null]]);
  });
});

const GARDEN_RAW_ID = 1_555_000_003;
const GARDEN_ID = -1_001_555_000_003;

describe("E2E: Rich messages", () => {
  const peer = { _: "peerChannel" as const, channelId: GARDEN_RAW_ID };
  const olderReport = richTlMessage(peer, 3, [
    {
      _: "pageBlockTable",
      title: { _: "textEmpty" },
      rows: [
        { _: "pageTableRow", cells: [cell("Crop", { header: true })] },
        { _: "pageTableRow", cells: [cell("Pumpkin")] },
      ],
    },
    { _: "pageBlockParagraph", text: plain("Older report") },
  ]);
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment("messages-rich");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: SELF_ID, is_active: true }]);
    const db = env.openCacheDb(1);
    createChatsCache(db).upsertMany([
      dialogToCacheInput(
        fakeDialog({
          kind: "supergroup",
          id: GARDEN_RAW_ID,
          title: "Garden Club",
          username: "gardenclub",
        }),
      ),
    ]);
    const plainMessage = {
      _: "message" as const,
      id: 1,
      peerId: peer,
      date: 1_760_000_001,
      message: "report coming",
    };
    takePartIn(db, GARDEN_ID);
    createMessagesCache(db).upsertBatch(
      [plainMessage, richTlMessage(peer, 2, REPORT_BLOCKS)].map((raw) =>
        parseRawMessage(raw, GARDEN_ID)!,
      ),
    );
    db.query(
      `INSERT INTO messages_cache (chat_id, message_id, text, message_type, date, fetched_at, raw_json)
       VALUES (?, 3, NULL, 'text', ?, 0, ?)`,
    ).run(GARDEN_ID, olderReport.date, toRawJson(olderReport));
    createHistoryRanges(db).add(GARDEN_ID, { low: 1, high: 3 });
  });

  afterAll(() => {
    env.cleanup();
  });

  const options = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  });

  it("lists a rich message with its text, and one cached before tg read them", async () => {
    const result = await runCliSuccess(["messages", "list", "--chat", "@gardenclub"], options());
    const { items } = (result.json as { data: ListData }).data;

    expect(items.map((item) => [item.messageId, item.messageType, item.text])).toEqual([
      [3, "text", "| Crop |\n|---|\n| Pumpkin |\n\nOlder report"],
      [2, "text", REPORT_TEXT],
      [1, "text", "report coming"],
    ]);
  });

  it("gets a rich message with its text", async () => {
    const result = await runCliSuccess(
      ["messages", "get", "--chat", "@gardenclub", "--id", "2"],
      options(),
    );
    const data = (result.json as { data: GetData }).data;

    expect(data.message).toMatchObject({
      messageId: 2,
      text: REPORT_TEXT,
      hasMedia: false,
      attachment: null,
      action: null,
    });
  });

  it("finds a rich message by a word only in a table cell", async () => {
    const result = await runCliSuccess(
      ["messages", "search", "--query", "zucchini", "--snippet"],
      options(),
    );
    const { results } = (
      result.json as {
        data: { results: Array<MessageSearchItem & { snippet: string }> };
      }
    ).data;

    expect(results.map((item) => [item.chatId, item.messageId])).toEqual([[GARDEN_ID, 2]]);
    expect(results[0]?.text).toBe(REPORT_TEXT);
    expect(results[0]?.snippet).toContain("Zucchini");
  });
});

function seedHistory(db: Database) {
  const now = Date.now();
  const usersCache = createUsersCache(db);
  takePartIn(db, -4242, -1001234567890);
  const messagesCache = createMessagesCache(db);

  usersCache.upsert({
    user_id: "10",
    username: "alice",
    first_name: "Alice",
    last_name: "Able",
    access_hash: "1111",
    fetched_at: now,
    raw_json: "{}",
  });
  usersCache.upsert({
    user_id: "11",
    username: "bob",
    first_name: "Bob",
    last_name: "Baker",
    fetched_at: now,
    raw_json: "{}",
  });

  createChatsCache(db).upsertMany(
    [
      fakeDialog({
        kind: "user",
        id: ALICE_ID,
        title: "Alice Able",
        username: "alice",
      }),
      fakeDialog({
        kind: "supergroup",
        id: 1234567890,
        title: "Team Chat",
        username: "teamchat",
      }),
      fakeDialog({ kind: "group", id: 4242, title: "Book Club" }),
    ].map(dialogToCacheInput),
  );

  const base = Math.floor(now / 1000) - 3600;
  const message = (
    chatId: number,
    messageId: number,
    fromId: number,
    text: string,
    extra: { is_deleted?: boolean; is_outgoing?: boolean } = {},
  ) => ({
    chat_id: chatId,
    message_id: messageId,
    from_id: fromId,
    text,
    message_type: "text",
    date: base + messageId * 60,
    raw_json: "{}",
    ...extra,
  });

  const aliceChat = [
    "hi!",
    "hi Alice",
    "lunch on Friday?",
    "sure, where?",
    "the noodle place",
    "see you at noon",
    "running late",
    "never mind",
  ].map((text, index) =>
    message(ALICE_ID, index + 1, index % 2 === 0 ? 10 : SELF_ID, text, {
      is_deleted: index === 7,
      is_outgoing: index % 2 === 1,
    }),
  );
  messagesCache.upsertBatch([
    ...aliceChat,
    message(TEAM_CHAT_ID, 1, 10, "standup at ten"),
    message(TEAM_CHAT_ID, 2, 10, "who ordered the pineapple pizza"),
    message(TEAM_CHAT_ID, 3, 11, "guilty"),
    message(BOOK_CLUB_ID, 1, 11, "next book: a short one"),
    message(SELF_ID, 1, SELF_ID, "buy milk", { is_outgoing: true }),
    message(SELF_ID, 2, SELF_ID, "call the dentist", { is_outgoing: true }),
    message(BOB_ID, 1, BOB_ID, "got the tickets"),
    message(NEW_DM_ID, 1, NEW_DM_ID, "one kiwi smoothie, please"),
  ]);

  const ranges = createHistoryRanges(db);
  for (const [chatId, high] of [
    [ALICE_ID, 8],
    [TEAM_CHAT_ID, 3],
    [BOOK_CLUB_ID, 1],
    [SELF_ID, 2],
    [BOB_ID, 1],
  ] as const) {
    ranges.add(chatId, { low: 1, high });
  }
}

function seedSecondAccount(db: Database) {
  createMessagesCache(db).upsertBatch([
    {
      chat_id: SECOND_SELF_ID,
      message_id: 5,
      from_id: SECOND_SELF_ID,
      text: "renew the passport",
      message_type: "text",
      date: Math.floor(Date.now() / 1000) - 3600 + 5 * 60,
      raw_json: "{}",
      is_outgoing: true,
    },
  ]);
  createHistoryRanges(db).add(SECOND_SELF_ID, { low: 1, high: 5 });
}
