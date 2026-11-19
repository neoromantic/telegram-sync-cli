import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { takePartIn } from "./participation.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { createChatsCache } from "../db/chats-cache";
import { createDaemonStatusService } from "../db/daemon-status";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import type { NextCommand } from "../types";
import { type CliResult, NO_CREDENTIALS, runCliSuccess, runShellCommand } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const TEAM_CHAT_ID = -1001234567890;
const ALICE_ID = 10;
const BOB_ID = 11;
const WORK = "Work Phone";
const PHRASE = `--it's $5 "today"`;

interface Answer {
  success: true;
  data: Record<string, unknown> & {
    items?: Array<{ id?: number; messageId?: number }>;
    results?: Array<{ messageId: number }>;
    messages?: Array<{ messageId: number }>;
  };
  next?: NextCommand[];
}

function answer(result: CliResult) {
  return result.json as Answer;
}

let env: TestEnvironment;

function options() {
  return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } };
}

async function follow(previous: Answer) {
  const command = previous.next?.[0]?.command;
  if (!command) throw new Error(`No next command: ${JSON.stringify(previous)}`);
  const result = await runShellCommand(command, options());
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed: ${result.stderr}`);
  }
  return answer(result);
}

async function run(...args: string[]) {
  return answer(await runCliSuccess(args, options()));
}

async function resolvedSince(duration: number, runIt: () => Promise<Answer>) {
  const start = Math.floor(Date.now() / 1000);
  const result = await runIt();
  const end = Math.ceil(Date.now() / 1000);
  const since = /--since=(\S+)/.exec(result.next?.[0]?.command ?? "")?.[1];
  const seconds = Date.parse(since ?? "") / 1000;
  expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(seconds).toBeGreaterThanOrEqual(start - duration);
  expect(seconds).toBeLessThanOrEqual(end - duration);
  return { answer: result, since: since! };
}

const WEEK = 7 * 86_400;

const messageIds = (data: Answer["data"]) =>
  (data.items ?? data.results ?? data.messages ?? []).map((m) => m.messageId);

function message(chatId: number, id: number, fromId: number, text: string) {
  return {
    chat_id: chatId,
    message_id: id,
    from_id: fromId,
    text,
    message_type: "text",
    date: Math.floor(Date.now() / 1000) - 3600 + id * 60,
    raw_json: "{}",
  };
}

beforeAll(() => {
  env = createTestEnvironment("next-commands");
  env.initDatabase();
  env.seedAccounts([
    { phone: "+15550000000", user_id: 999, is_active: true },
    { phone: "+15550000001", user_id: 998, label: WORK, is_active: false },
  ]);

  const first = env.openCacheDb(1);
  createChatsCache(first).upsertMany(
    [
      fakeDialog({ kind: "group", id: 4241, title: "Book Club" }),
      fakeDialog({ kind: "group", id: 4242, title: "Chess Club" }),
      fakeDialog({ kind: "group", id: 4243, title: "Film Club" }),
      fakeDialog({ kind: "user", id: ALICE_ID, title: "Alice Able" }),
    ].map(dialogToCacheInput),
  );
  createUsersCache(first).upsertMany(
    ["Ann", "Ben", "Cid"].map((name, index) => ({
      user_id: String(20 + index),
      first_name: name,
      is_contact: 1,
      fetched_at: Date.now(),
      raw_json: "{}",
    })),
  );
  takePartIn(first, -4241, -4242, -4243, TEAM_CHAT_ID);
  createMessagesCache(first).upsertBatch(
    [1, 2, 3, 4].map((id) => message(TEAM_CHAT_ID, id, ALICE_ID, `old ${id}`)),
  );
  createChatsCache(first).upsertMany(
    [fakeDialog({ kind: "supergroup", id: 1234567890, title: "Team Chat" })].map(
      dialogToCacheInput,
    ),
  );

  const work = env.openCacheDb(2);
  createUsersCache(work).upsertMany(
    [
      { user_id: String(ALICE_ID), username: "alice", first_name: "Alice" },
      { user_id: String(BOB_ID), username: "bob", first_name: "Bob" },
    ].map((user) => ({ ...user, fetched_at: Date.now(), raw_json: "{}" })),
  );
  createChatsCache(work).upsertMany(
    [fakeDialog({ kind: "supergroup", id: 1234567890, title: "Team Chat" })].map(
      dialogToCacheInput,
    ),
  );
  takePartIn(work, -4241, -4242, -4243, TEAM_CHAT_ID);
  createMessagesCache(work).upsertBatch([
    ...[1, 2, 3, 4, 5].map((id) => message(TEAM_CHAT_ID, id, ALICE_ID, `it's $5 "today" (${id})`)),
    message(TEAM_CHAT_ID, 6, BOB_ID, `it's $5 "today" (6)`),
    message(TEAM_CHAT_ID, 7, BOB_ID, "see you"),
  ]);
  createHistoryRanges(work).add(TEAM_CHAT_ID, { low: 1, high: 7 });
});

afterAll(() => {
  env.cleanup();
});

describe("E2E: next for messages list", () => {
  it("pages back with the account, chat and filters kept", async () => {
    const first = await run(
      "messages",
      "list",
      "--chat",
      String(TEAM_CHAT_ID),
      "--limit",
      "3",
      "--account",
      WORK,
    );
    expect(messageIds(first.data)).toEqual([7, 6, 5]);
    expect(first.next).toEqual([
      {
        command: `tg messages list --chat=${TEAM_CHAT_ID} --limit=3 --before=5 --account='Work Phone'`,
        why: "The next page of older messages.",
      },
    ]);

    const second = await follow(first);
    expect(messageIds(second.data)).toEqual([4, 3, 2]);
    expect(second.data.before).toBe(5);
    const third = await follow(second);
    expect(messageIds(third.data)).toEqual([1]);
    expect(third.next).toBeUndefined();
  });

  it("pages forward from --after", async () => {
    const first = await run(
      "messages",
      "list",
      "--chat",
      String(TEAM_CHAT_ID),
      "--limit",
      "3",
      "--after",
      "0",
      "--account",
      WORK,
    );
    expect(messageIds(first.data)).toEqual([3, 2, 1]);
    expect(first.next?.[0]?.command).toBe(
      `tg messages list --chat=${TEAM_CHAT_ID} --limit=3 --after=3 --account='Work Phone'`,
    );
    expect(first.next?.[0]?.why).toBe("The next page of newer messages.");

    const second = await follow(first);
    expect(messageIds(second.data)).toEqual([6, 5, 4]);
    expect(second.data.after).toBe(3);
  });

  it("keeps --type, --since and --until, with a repeated --type as one list", async () => {
    const { answer: first, since } = await resolvedSince(WEEK, () =>
      run(
        "messages",
        "list",
        "--chat",
        String(TEAM_CHAT_ID),
        "--limit",
        "2",
        "--type",
        "text",
        "--type",
        "voice",
        "--since",
        "7d",
        "--account",
        WORK,
      ),
    );
    expect(messageIds(first.data)).toEqual([7, 6]);
    expect(first.next?.[0]?.command).toBe(
      `tg messages list --chat=${TEAM_CHAT_ID} --limit=2 --before=6 --type=text,voice --since=${since} --account='Work Phone'`,
    );

    const second = await follow(first);
    expect(messageIds(second.data)).toEqual([5, 4]);
  });
});

describe("E2E: next for messages search", () => {
  it("keeps an awkward query, the account and every filter", async () => {
    const { answer: first, since } = await resolvedSince(WEEK, () =>
      run(
        "messages",
        "search",
        "--query",
        PHRASE,
        "--phrase",
        "--chat",
        String(TEAM_CHAT_ID),
        "--sender",
        "@alice",
        "--since",
        "7d",
        "--count",
        "--limit",
        "2",
        "--account",
        WORK,
      ),
    );
    expect(messageIds(first.data)).toEqual([5, 4]);
    expect(first.data.count).toBe(5);
    expect(first.next).toEqual([
      {
        command: `tg messages search --query='--it'\\''s $5 "today"' --phrase --limit=2 --offset=2 --chat=${TEAM_CHAT_ID} --sender=@alice --since=${since} --count --account='Work Phone'`,
        why: "The next page of results.",
      },
    ]);

    const second = await follow(first);
    expect(messageIds(second.data)).toEqual([3, 2]);
    expect(second.data).toMatchObject({
      query: PHRASE,
      offset: 2,
      limit: 2,
      count: 5,
      filters: { chat: String(TEAM_CHAT_ID), sender: "@alice", since },
    });
    const third = await follow(second);
    expect(messageIds(third.data)).toEqual([1]);
    expect(third.next).toBeUndefined();
  });

  it("keeps a repeated --type as one list", async () => {
    const first = await run(
      "messages",
      "search",
      "--query",
      "today",
      "--type",
      "text",
      "--type",
      "voice",
      "--limit",
      "2",
      "--account",
      WORK,
    );
    expect(messageIds(first.data)).toEqual([6, 5]);
    expect(first.next?.[0]?.command).toBe(
      `tg messages search --query=today --limit=2 --offset=2 --type=text,voice --account='Work Phone'`,
    );

    const second = await follow(first);
    expect(messageIds(second.data)).toEqual([4, 3]);
    expect(second.data.filters).toMatchObject({ type: ["text", "voice"] });
  });

  it("suggests nothing when the page holds every match", async () => {
    const data = await run("messages", "search", "--query", "see you", "--account", WORK);
    expect(messageIds(data.data)).toEqual([7]);
    expect(data.next).toBeUndefined();
  });
});

describe("E2E: next for chats list and contacts list", () => {
  it("pages chats with the type filter kept", async () => {
    const first = await run("chats", "list", "--type", "group", "--limit", "2");
    expect(first.data.hasMore).toBe(true);
    expect(first.next).toEqual([
      {
        command: "tg chats list --limit=2 --offset=2 --type=group",
        why: "The next page of chats.",
      },
    ]);
    const second = await follow(first);
    expect(second.data).toMatchObject({ offset: 2, hasMore: false });
    const ids = [...(first.data.items ?? []), ...(second.data.items ?? [])]
      .map((chat) => chat.id)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(ids).toEqual([-4243, -4242, -4241]);
    expect(second.next).toBeUndefined();
  });

  it("pages contacts", async () => {
    const first = await run("contacts", "list", "--limit", "2", "--account", "1");
    expect(first.next).toEqual([
      {
        command: "tg contacts list --limit=2 --offset=2 --account=1",
        why: "The next page of contacts.",
      },
    ]);
    const second = await follow(first);
    expect(second.data).toMatchObject({ offset: 2, total: 3, hasMore: false });
    expect(second.data.items).toHaveLength(1);
    expect(second.next).toBeUndefined();
  });
});

describe("E2E: next for messages wait", () => {
  it("waits on from the last message it returned", async () => {
    writeFileSync(join(env.dataDir, "daemon.pid"), String(process.pid));
    createDaemonStatusService(env.openCacheDb(1)).setDaemonRunning(process.pid, "test");

    const first = await run(
      "messages",
      "wait",
      "--chat",
      String(TEAM_CHAT_ID),
      "--after",
      "2",
      "--timeout",
      "0",
    );
    expect(messageIds(first.data)).toEqual([3, 4]);
    expect(first.next).toEqual([
      {
        command: `tg messages wait --chat=${TEAM_CHAT_ID} --after=4 --timeout=0`,
        why: "Waits for the chat's next messages after these, so none is missed.",
      },
    ]);

    takePartIn(env.openCacheDb(1), -4241, -4242, -4243, TEAM_CHAT_ID);

    createMessagesCache(env.openCacheDb(1)).upsertBatch([
      message(TEAM_CHAT_ID, 5, ALICE_ID, "new"),
    ]);
    const second = await follow(first);
    expect(messageIds(second.data)).toEqual([5]);
  });
});

describe("E2E: next for an empty chat cache", () => {
  it("suggests filling the cache, then the same search", async () => {
    const empty = createTestEnvironment("next-commands-empty");
    try {
      empty.initDatabase();
      empty.seedAccounts([{ phone: "+15550000002", is_active: true }]);
      empty.openCacheDb(1);
      const result = await runCliSuccess(
        ["chats", "search", "--query", "team chat", "--account", "1"],
        { env: { ...empty.getCliOptions().env, ...NO_CREDENTIALS } },
      );
      const json = answer(result);
      expect(json.data).toMatchObject({
        results: [],
        total: 0,
        message: 'No results in cache. Run "tg chats list --fresh" to populate cache first.',
      });
      expect(json.next).toEqual([
        {
          command: "tg chats list --account=1 --fresh",
          why: "The chat cache is empty: this fills it from Telegram.",
        },
        {
          command: `tg chats search --query='team chat' --account=1`,
          why: "Then search the refreshed cache again.",
        },
      ]);
    } finally {
      empty.cleanup();
    }
  });

  it("says a refresh may find a chat the cache lacks", async () => {
    const json = await run("chats", "search", "--query", "nothing like it");
    expect(json.next?.map((next) => next.command)).toEqual([
      "tg chats list --fresh",
      `tg chats search --query='nothing like it'`,
    ]);
    expect(json.next?.[0]?.why).toBe(
      "No cached chat matches: this refreshes the chat list from Telegram.",
    );
  });
});

describe("E2E: next in other output formats", () => {
  it("prints next on stderr in pretty and leaves stdout the data", async () => {
    const result = await runCliSuccess(
      ["-f", "pretty", "chats", "list", "--type", "group", "--limit", "2"],
      options(),
    );
    const data = JSON.parse(result.stdout);
    expect(data.items).toHaveLength(2);
    expect(data.next).toBeUndefined();
    expect(result.stderr).toContain(
      "Next: The next page of chats.\n  tg chats list --limit=2 --offset=2 --type=group",
    );
  });

  it("prints nothing in quiet", async () => {
    const result = await runCliSuccess(
      ["-q", "chats", "list", "--type", "group", "--limit", "2"],
      options(),
    );
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
