import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { takePartIn } from "./participation.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import type { WordForms } from "../db/word-forms";
import type { MessageSearchItem } from "../types";
import { runCli, runCliSuccess, runShellCommand } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const TEAM_CHAT_ID = -1001234567890;
const BOOK_CLUB_ID = -4242;
const ALICE_ID = 10;
const BOB_ID = 11;
const HOUR = 3600;
const DAY = 24 * HOUR;

const MESSAGES = [
  [1, TEAM_CHAT_ID, ALICE_ID, "Сдаю квартиру у парка", 1 * HOUR, false],
  [2, TEAM_CHAT_ID, BOB_ID, "Квартира ещё свободна?", 2 * HOUR, false],
  [3, BOOK_CLUB_ID, ALICE_ID, "Поговорим о квартирах и ценах", 3 * DAY, false],
  [4, BOOK_CLUB_ID, BOB_ID, "Квартал рядом шумный", 4 * HOUR, false],
  [5, TEAM_CHAT_ID, ALICE_ID, "The meetings ran late", 5 * HOUR, false],
  [6, TEAM_CHAT_ID, BOB_ID, "One meeting is enough", 6 * HOUR, false],
  [7, BOOK_CLUB_ID, ALICE_ID, "Meet me at noon", 7 * HOUR, false],
  [8, TEAM_CHAT_ID, ALICE_ID, "Квартирой займёмся позже", 8 * HOUR, true],
  [9, BOOK_CLUB_ID, BOB_ID, "Квартиры дорожают", 40 * DAY, false],
  [10, TEAM_CHAT_ID, BOB_ID, "Еще раз про парк", 9 * HOUR, false],
  [11, BOOK_CLUB_ID, ALICE_ID, "Budget notes", 10 * HOUR, false],
  [12, BOOK_CLUB_ID, BOB_ID, "Budget review", 11 * HOUR, false],
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
  takePartIn(db, BOOK_CLUB_ID, TEAM_CHAT_ID);
  const nowSec = Math.floor(now / 1000);
  const messages = createMessagesCache(db);
  messages.upsertBatch(
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
  for (const [id, chatId, , , , deleted] of MESSAGES) {
    if (deleted) messages.markDeleted(chatId, [id]);
  }
}

interface SearchData {
  results: Array<MessageSearchItem & { snippet?: string }>;
  filters: { forms: boolean; phrase: boolean };
  forms: Record<string, WordForms> | null;
  count: number | null;
  offset: number;
}

interface SearchAnswer {
  data: SearchData;
  next?: Array<{ command: string }>;
}

describe("E2E: messages search --forms", () => {
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment("messages-search-forms");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", is_active: true }]);
    seed(env.openCacheDb(1));
  });

  afterAll(() => {
    env.cleanup();
  });

  async function search(query: string, ...args: string[]) {
    const result = await runCliSuccess(
      ["messages", "search", "--query", query, ...args],
      env.getCliOptions(),
    );
    return result.json as SearchAnswer;
  }

  async function ids(query: string, ...args: string[]) {
    const { data } = await search(query, ...args);
    return data.results.map((item) => item.messageId).sort((a, b) => a - b);
  }

  it("finds other forms of a Russian word with --forms, and only the word itself without", async () => {
    const exact = await search("квартира");
    expect(exact.data.results.map((item) => item.messageId)).toEqual([2]);
    expect(exact.data.filters.forms).toBe(false);
    expect(exact.data.forms).toBeNull();

    const forms = await search("квартира", "--forms");
    expect(forms.data.results.map((item) => item.messageId)).toEqual([1, 2, 3, 9]);
    expect(forms.data.filters.forms).toBe(true);
    expect(forms.data.forms).toEqual({
      квартира: {
        words: ["квартира", "квартирах", "квартирой", "квартиру", "квартиры"],
        cut: false,
      },
    });
  });

  it("finds other forms of an English word with --forms", async () => {
    expect(await ids("meeting")).toEqual([6]);
    expect(await ids("meeting", "--forms")).toEqual([5, 6]);
    expect(await ids("Meetings late", "--forms")).toEqual([5]);
  });

  it("reads ё as е with --forms only", async () => {
    expect(await ids("еще")).toEqual([10]);
    expect(await ids("ещё")).toEqual([2]);
    expect(await ids("еще", "--forms")).toEqual([2, 10]);
    expect(await ids("ещё", "--forms")).toEqual([2, 10]);
  });

  it("finds nothing for a word with no form in the cache", async () => {
    const { data } = await search("квартирка", "--forms");
    expect(data.results).toEqual([]);
    expect(data.forms).toEqual({ квартирка: { words: [], cut: false } });
  });

  it("matches a query with FTS5 syntax or --phrase as written", async () => {
    expect(await ids('"квартира ещё"')).toEqual([2]);
    expect(await ids("квартира ещё", "--phrase")).toEqual([2]);
    expect(await ids("квартира OR meeting")).toEqual([2, 6]);
    expect(await ids("квартир*")).toEqual([1, 2, 3, 9]);
  });

  it("refuses --forms with FTS5 syntax or --phrase, with a suggestion", async () => {
    for (const args of [
      ['"квартира у парка"'],
      ["квартир*"],
      ["квартира OR парк"],
      ["sender:alice квартира"],
      ["chat:team квартира"],
      ["квартира парка", "--phrase"],
    ]) {
      const result = await runCli(
        ["messages", "search", "--query", ...args, "--forms"],
        env.getCliOptions(),
      );
      const json = result.json as { error: { code: string; suggestion?: string } };
      expect(result.exitCode).toBe(3);
      expect(json.error.code).toBe("INVALID_ARGS");
      expect(json.error.suggestion).toContain("Drop --forms");
    }
  });

  it("keeps the chat, sender, date and deleted filters", async () => {
    expect(await ids("квартира", "--forms", "--chat", "@teamchat")).toEqual([1, 2]);
    expect(await ids("квартира", "--forms", "--sender", "@bob")).toEqual([2, 9]);
    expect(await ids("квартира", "--forms", "--since", "7d")).toEqual([1, 2, 3]);
    expect(await ids("квартира", "--forms", "--until", "7d")).toEqual([9]);
    expect(await ids("квартира", "--forms", "--includeDeleted")).toEqual([1, 2, 3, 8, 9]);
  });

  it("matches words as typed with --forms while allowedChats is set, so no word of another chat shows", async () => {
    const result = await runCliSuccess(["messages", "search", "--query", "квартира", "--forms"], {
      env: { ...env.getCliOptions().env, TELEGRAM_SYNC_CLI_ALLOWED_CHATS: "@teamchat" },
    });
    const { data } = result.json as SearchAnswer;
    expect(data.results.map((item) => item.messageId)).toEqual([2]);
    expect(data.filters.forms).toBe(true);
    expect(data.forms).toBeNull();
    expect(result.stdout).not.toContain("квартирах");
    expect(result.stdout).not.toContain("квартиры");
  });

  it("sorts by relevance, counts, and highlights every form in snippets", async () => {
    const { data } = await search(
      "квартира",
      "--forms",
      "--sort",
      "relevance",
      "--count",
      "--snippet",
    );
    expect(data.count).toBe(4);
    expect(Object.fromEntries(data.results.map((item) => [item.messageId, item.snippet]))).toEqual({
      1: "Сдаю **квартиру** у парка",
      2: "**Квартира** ещё свободна?",
      3: "Поговорим о **квартирах** и ценах",
      9: "**Квартиры** дорожают",
    });
  });

  it("carries --forms into the next page, and pages on exact without it", async () => {
    const exact = await search("budget", "--limit", "1");
    expect(exact.next?.[0]?.command).toBe("tg messages search --query=budget --limit=1 --offset=1");

    const first = await search("квартира", "--forms", "--limit", "3");
    expect(first.data.results.map((item) => item.messageId)).toEqual([1, 2, 3]);
    const command = first.next?.[0]?.command;
    expect(command).toBe("tg messages search --query='квартира' --forms --limit=3 --offset=3");

    const result = await runShellCommand(command!, env.getCliOptions());
    expect(result.exitCode).toBe(0);
    const second = result.json as SearchAnswer;
    expect(second.data.results.map((item) => item.messageId)).toEqual([9]);
    expect(second.data.offset).toBe(3);
    expect(second.next).toBeUndefined();
  });
});
