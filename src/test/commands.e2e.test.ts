import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { createChatsCache } from "../db/chats-cache";
import { createUsersCache } from "../db/users-cache";
import { NO_CREDENTIALS, runCli, runCliFailure, runCliSuccess } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const CHANNEL_ID = -1000000012345;

function user(user_id: string, first_name: string, extra: Record<string, unknown> = {}) {
  return { user_id, first_name, fetched_at: Date.now(), raw_json: "{}", ...extra };
}

let env: TestEnvironment;

function options() {
  return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } };
}

async function data<T>(args: string[]) {
  const result = await runCliSuccess(args, options());
  return (result.json as { data: T }).data;
}

beforeAll(() => {
  env = createTestEnvironment("commands");
  env.initDatabase();
  env.seedAccounts([{ phone: "+15550000000", is_active: true }]);
  const cacheDb = env.openCacheDb(1);
  createUsersCache(cacheDb).upsertMany([
    ...Array.from({ length: 1001 }, (_, i) => user(String(1000 + i), `Aaron ${i}`)),
    user("100", "Alice", { last_name: "Able", username: "reader_one", is_contact: 1 }),
    user("101", "Alice", { last_name: "Baker", username: "reader_two", is_contact: 1 }),
    user("102", "Bob", { last_name: "Builder", username: "bob_builder", is_contact: 1 }),
    user("103", "Example Bot", { username: "example_bot", is_bot: 1 }),
    user("12345", "Test", {
      last_name: "User",
      username: "testuser",
      phone: "1234567890",
      is_contact: 1,
      is_premium: 1,
    }),
  ]);
  createChatsCache(cacheDb).upsertMany([
    {
      ...dialogToCacheInput(
        fakeDialog({
          kind: "channel",
          id: 12345,
          title: "Test Channel",
          username: "testchannel",
          membersCount: 5000,
        }),
      ),
      is_admin: 1,
    },
    ...[
      fakeDialog({ kind: "user", id: 100, title: "Alice Springs", username: "alice_springs" }),
      fakeDialog({ kind: "group", id: 200, title: "Alice Book Club" }),
      fakeDialog({ kind: "supergroup", id: 400, title: "Alice Fans Club" }),
      fakeDialog({ kind: "channel", id: 300, title: "Tech News", username: "technews" }),
    ].map(dialogToCacheInput),
  ]);
});

afterAll(() => {
  env.cleanup();
});

describe("E2E: contacts", () => {
  it("lists only the cached contacts, behind more than 1000 other users", async () => {
    const list = await data<{ items: unknown[]; total: number; source: string }>([
      "contacts",
      "list",
    ]);

    expect(list).toMatchObject({ total: 4, source: "cache" });
    expect(list.items).toEqual([
      { id: 100, firstName: "Alice", lastName: "Able", username: "reader_one", phone: null },
      { id: 101, firstName: "Alice", lastName: "Baker", username: "reader_two", phone: null },
      { id: 102, firstName: "Bob", lastName: "Builder", username: "bob_builder", phone: null },
      { id: 12345, firstName: "Test", lastName: "User", username: "testuser", phone: "1234567890" },
    ]);
  });

  it("searches the cached users by username up to --limit", async () => {
    const search = await data<{ results: Array<{ firstName: string }> }>([
      "contacts",
      "search",
      "--query",
      "reader",
      "--limit",
      "1",
    ]);

    expect(search).toMatchObject({ query: "reader", total: 1, source: "cache" });
    expect(search.results.map((result) => result.firstName)).toEqual(["Alice"]);
  });

  it("gets a cached user by ID, @username or bare username", async () => {
    for (const id of ["12345", "@testuser", "testuser"]) {
      expect(await data(["contacts", "get", "--id", id])).toEqual({
        id: 12345,
        firstName: "Test",
        lastName: "User",
        username: "testuser",
        phone: "1234567890",
        isBot: false,
        isPremium: true,
        isContact: true,
        source: "cache",
        stale: false,
      });
    }
  });
});

describe("E2E: chats", () => {
  it("searches cached chats by title up to --limit", async () => {
    const search = await data<{ results: Array<{ title: string }> }>([
      "chats",
      "search",
      "--query",
      "Alice",
      "--limit",
      "2",
    ]);

    expect(search).toMatchObject({ query: "Alice", total: 2, source: "cache" });
    expect(search.results.map((result) => result.title)).toEqual([
      expect.stringMatching(/^Alice /),
      expect.stringMatching(/^Alice /),
    ]);
  });

  it("gets a cached chat by the marked ID tg chats list prints, @username or bare username", async () => {
    for (const id of [`--id=${CHANNEL_ID}`, "--id=@testchannel", "--id=testchannel"]) {
      expect(await data(["chats", "get", id])).toEqual({
        id: CHANNEL_ID,
        type: "channel",
        title: "Test Channel",
        username: "testchannel",
        memberCount: 5000,
        lastMessageAt: null,
        isCreator: false,
        isAdmin: true,
        unreadCount: null,
        source: "cache",
        stale: false,
      });
    }
  });

  it("rejects an unknown chat type and names the valid ones", async () => {
    const result = await runCliFailure(["chats", "list", "--type", "invalid"], 3, options());

    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: "INVALID_ARGS",
        message:
          "Invalid chat type: invalid. Must be one of: private, group, supergroup, channel, community",
      },
    });
  });

  it("reports an ID the cache does not hold as a cache miss, without credentials", async () => {
    const result = await runCliFailure(["chats", "get", "--id=-1009999999999"], 3, options());

    expect(result.json).toEqual({
      success: false,
      error: {
        code: "INVALID_ARGS",
        message: "Chat -1009999999999 is not in the cache; fetching by ID is not supported yet",
        details: { identifier: "-1009999999999" },
        suggestion:
          "Start the daemon (its dialog pass caches every chat, archived ones too) or use @username",
        retryable: false,
      },
    });
  });

  it("rejects an ID with --fresh before asking Telegram", async () => {
    const result = await runCliFailure(
      ["chats", "get", `--id=${CHANNEL_ID}`, "--fresh"],
      3,
      options(),
    );

    expect(result.json).toEqual({
      success: false,
      error: {
        code: "INVALID_ARGS",
        message: `Fetching chat ${CHANNEL_ID} by ID is not supported yet; --fresh needs @username`,
        details: { identifier: String(CHANNEL_ID) },
        suggestion: "Use @username, or drop --fresh to read the cache",
        retryable: false,
      },
    });
  });
});

describe("E2E: an empty cache", () => {
  it("asks Telegram for contacts and chats the cache lacks", async () => {
    const empty = createTestEnvironment("commands-empty");
    empty.initDatabase();
    empty.seedAccounts([{ phone: "+15550000000", is_active: true }]);
    try {
      for (const args of [
        ["contacts", "list"],
        ["contacts", "search", "--query", "nobody"],
        ["chats", "list"],
      ]) {
        const result = await runCli(args, {
          env: { ...empty.getCliOptions().env, ...NO_CREDENTIALS },
        });
        expect(result.exitCode).toBe(3);
        expect(result.stderr).toContain("TELEGRAM_API_ID");
      }
    } finally {
      empty.cleanup();
    }
  });
});
