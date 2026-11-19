import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { takePartIn } from "./participation.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import type { MessageSearchItem } from "../types";
import { runCli, runCliSuccess } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const TEAM_CHAT_ID = -1001234567890;
const BOOK_CLUB_ID = -4242;
const ALICE_ID = 10;
const BOB_ID = 11;
const HOUR = 3600;
const DAY = 24 * HOUR;

const MESSAGES = [
  [1, TEAM_CHAT_ID, ALICE_ID, "the deploy failed with an error", 1 * HOUR],
  [3, TEAM_CHAT_ID, ALICE_ID, "hello there, wide world", 3 * HOUR],
  [4, BOOK_CLUB_ID, BOB_ID, "world, hello", 2 * DAY],
  [5, BOOK_CLUB_ID, ALICE_ID, "hello world from the club", 10 * DAY],
  [10, BOOK_CLUB_ID, BOB_ID, "deploy deploy deploy", 40 * DAY],
] as const;

function seed(db: Database) {
  const now = Date.now();
  const users = createUsersCache(db);
  for (const [id, username, first] of [
    [ALICE_ID, "alice", "Alice"],
    [BOB_ID, "bob", "Bob"],
  ] as const) {
    users.upsert({
      user_id: String(id),
      username,
      first_name: first,
      last_name: null,
      fetched_at: now,
      raw_json: "{}",
    });
  }
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
    ].map(dialogToCacheInput),
  );
  const nowSec = Math.floor(now / 1000);
  takePartIn(db, -4242, -1001234567890);
  createMessagesCache(db).upsertBatch(
    MESSAGES.map(([message_id, chat_id, from_id, text, age]) => ({
      chat_id,
      message_id,
      from_id,
      text,
      message_type: "text",
      date: nowSec - age,
      raw_json: "{}",
    })),
  );
}

describe("E2E: messages search query rules", () => {
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment("messages-search-query");
    env.initDatabase();
    env.seedAccounts([
      { phone: "+15550000000", is_active: true },
      { phone: "+15550000001", user_id: ALICE_ID },
    ]);
    seed(env.openCacheDb(1));
    const own = env.openCacheDb(2);
    seed(own);
    createMessagesCache(own).upsertBatch([
      {
        chat_id: ALICE_ID,
        message_id: 12,
        from_id: ALICE_ID,
        text: "hello note to self",
        message_type: "text",
        date: Math.floor(Date.now() / 1000),
        raw_json: "{}",
      },
    ]);
  });

  afterAll(() => {
    env.cleanup();
  });

  async function ids(...args: string[]) {
    const result = await runCliSuccess(
      ["messages", "search", "--query", ...args],
      env.getCliOptions(),
    );
    return (result.json as { data: { results: MessageSearchItem[] } }).data.results
      .map((item) => item.messageId)
      .sort((a, b) => a - b);
  }

  it("matches every word of a plain query in any order", async () => {
    expect(await ids("hello world")).toEqual([3, 4, 5]);
  });

  it("matches the whole query as one phrase with --phrase", async () => {
    expect(await ids("hello world", "--phrase")).toEqual([5]);
  });

  it("passes a query with FTS5 syntax as written", async () => {
    expect(await ids("sender:alice AND chat:club")).toEqual([5]);
  });

  it("returns INVALID_ARGS with a suggestion for a query FTS5 cannot parse", async () => {
    for (const query of ["function(arg)", "meet at 10:30"]) {
      const result = await runCli(["messages", "search", "--query", query], env.getCliOptions());
      const json = result.json as {
        success: boolean;
        error: { code: string; suggestion?: string };
      };
      expect(result.exitCode).toBe(3);
      expect(json.error.code).toBe("INVALID_ARGS");
      expect(json.error.suggestion).toContain("--phrase");
    }
  });

  async function searchData(...args: string[]) {
    const result = await runCliSuccess(
      ["messages", "search", "--query", ...args],
      env.getCliOptions(),
    );
    return (
      result.json as {
        data: {
          results: MessageSearchItem[];
          total: number;
          count: number | null;
          sort: string;
        };
      }
    ).data;
  }

  async function invalidArgs(...args: string[]) {
    const result = await runCli(["messages", "search", "--query", ...args], env.getCliOptions());
    expect(result.exitCode).toBe(3);
    return (result.json as { error: { code: string } }).error.code;
  }

  it("limits matches to a date range", async () => {
    expect(await ids("hello world", "--since", "7d", "--until", "1d")).toEqual([4]);
  });

  it("rejects a date it cannot read, and an empty range", async () => {
    expect(await invalidArgs("hello", "--since", "yesterday")).toBe("INVALID_ARGS");
    expect(await invalidArgs("hello", "--since", "1d", "--until", "7d")).toBe("INVALID_ARGS");
  });

  it("reads me in --chat and --sender as the own user ID", async () => {
    expect(await ids("hello", "--account", "2", "--chat", "ME")).toEqual([12]);
    expect(await ids("hello", "--account", "2", "--sender", "me")).toEqual([3, 5, 12]);
  });

  it("rejects me without a known own user ID, and a value that is no peer", async () => {
    expect(await invalidArgs("hello", "--chat", "me")).toBe("INVALID_ARGS");
    expect(await invalidArgs("hello", "--chat", "12abc")).toBe("INVALID_ARGS");
    expect(await invalidArgs("hello", "--sender", "1.5")).toBe("INVALID_ARGS");
    const result = await runCli(
      ["messages", "search", "--query", "hello", "--sender", "a b"],
      env.getCliOptions(),
    );
    expect(result.json).toMatchObject({
      error: { message: "Invalid --sender: a b", details: { sender: "a b" } },
    });
    expect(await ids("hello", "--chat", "teamchat")).toEqual([3]);
  });

  it("orders by date with no count or snippet by default, and by bm25 with --sort relevance", async () => {
    const byDate = await searchData("deploy");
    expect(byDate.sort).toBe("date");
    expect(byDate.results.map((item) => item.messageId)).toEqual([1, 10]);
    expect(byDate.count).toBeNull();
    expect(byDate.results[0]).not.toHaveProperty("snippet");

    const byRelevance = await searchData("deploy", "--sort", "relevance");
    expect(byRelevance.sort).toBe("relevance");
    expect(byRelevance.results.map((item) => item.messageId)).toEqual([10, 1]);

    expect(await invalidArgs("deploy", "--sort", "size")).toBe("INVALID_ARGS");
  });

  it("counts every match with --count, while total is the page size", async () => {
    const page = await searchData("hello world", "--limit", "1", "--count");
    expect(page.total).toBe(1);
    expect(page.count).toBe(3);
  });

  it("adds a highlighted snippet to each result with --snippet", async () => {
    const { results } = await searchData("hel* world", "--snippet");

    expect(
      Object.fromEntries(
        results.map((item) => [
          item.messageId,
          (item as MessageSearchItem & { snippet: string }).snippet,
        ]),
      ),
    ).toEqual({
      3: "**hello** there, wide **world**",
      4: "**world**, **hello**",
      5: "**hello** **world** from the club",
    });
  });
});
