import { afterEach, beforeEach, describe, expect, it, setSystemTime } from "bun:test";

import { type ChatsCache, createChatsCache, type ListChatsOptions } from "./chats-cache";
import type { ChatType, DurationString } from "./types";
import { isCacheStale, parseDuration } from "./types";
import { createUsersCache, type UserCacheInput, type UsersCache } from "./users-cache";
import { chatRow, createAccountCacheDb } from "../test/cache-db.test-utils";

const NOW = 1_700_000_000_000;

afterEach(() => {
  setSystemTime();
});

describe("parseDuration", () => {
  it("converts a whole number of s, m, h, d or w to milliseconds", () => {
    const durations = ["0s", "30s", "5m", "1h", "7d", "2w"] as const;
    expect(durations.map((duration) => parseDuration(duration))).toEqual([
      0, 30_000, 300_000, 3_600_000, 604_800_000, 1_209_600_000,
    ]);
  });

  it("rejects anything but a whole number and one unit", () => {
    for (const value of ["30", "s", "30x", "-5m", "1.5h", "", "30 s"]) {
      expect(() => parseDuration(value as DurationString)).toThrow(`Invalid duration: ${value}`);
    }
  });
});

describe("isCacheStale", () => {
  it("is stale without a fetch time or once older than the TTL", () => {
    setSystemTime(NOW);
    expect(isCacheStale(null, 60_000)).toBe(true);
    expect(isCacheStale(NOW - 60_000, 60_000)).toBe(false);
    expect(isCacheStale(NOW - 60_001, 60_000)).toBe(true);
  });
});

describe("UsersCache", () => {
  let usersCache: UsersCache;

  const user = (overrides: Partial<UserCacheInput> = {}) => ({
    user_id: "1",
    username: "Ann_Example",
    first_name: "Ann",
    last_name: "Lee",
    phone: null,
    fetched_at: 1_000,
    raw_json: '{"_":"user","id":1}',
    ...overrides,
  });

  beforeEach(() => {
    usersCache = createUsersCache(createAccountCacheDb());
  });

  it("writes one row per user and updates it in place", () => {
    setSystemTime(NOW);
    usersCache.upsert(user());
    setSystemTime(NOW + 60_000);
    usersCache.upsertMany([
      user({ first_name: "Anna", fetched_at: 2_000, raw_json: '{"_":"user","id":1,"v":2}' }),
      user({ user_id: "2" }),
    ]);

    expect(usersCache.count()).toBe(2);
    expect(usersCache.getById("1")).toMatchObject({
      first_name: "Anna",
      fetched_at: 2_000,
      raw_json: '{"_":"user","id":1,"v":2}',
      created_at: NOW,
      updated_at: NOW + 60_000,
    });
    expect(usersCache.getById("3")).toBeNull();
  });

  it("names a user by first and last name, or null without either", () => {
    const names = [
      ["Ann", "Lee", "Ann Lee"],
      ["Ann", null, "Ann"],
      [null, "Lee", "Lee"],
      [null, null, null],
    ] as const;
    for (const [i, [first, last, displayName]] of names.entries()) {
      usersCache.upsert(user({ user_id: String(i), first_name: first, last_name: last }));
      expect(usersCache.getById(String(i))?.display_name).toBe(displayName);
    }
  });

  it("finds a user by username with or without @, in any case", () => {
    usersCache.upsert(user());

    for (const username of ["ann_example", "@ANN_EXAMPLE", "Ann_Example"]) {
      expect(usersCache.getByUsername(username)?.user_id).toBe("1");
    }
    expect(usersCache.getByUsername("nobody")).toBeNull();
  });

  it("finds a user by phone written with +, spaces, dashes or parentheses", () => {
    usersCache.upsert(user({ phone: "15550001111" }));

    for (const phone of ["15550001111", "+1 555 000 1111", "+1 (555) 000-1111"]) {
      expect(usersCache.getByPhone(phone)?.user_id).toBe("1");
    }
    expect(usersCache.getByPhone("15559999999")).toBeNull();
  });

  it("searches names, usernames and phones in part, ordered by display name", () => {
    usersCache.upsertMany([
      user({ user_id: "1", username: "alice", first_name: "Alice", last_name: "Smith" }),
      user({
        user_id: "2",
        username: "bob",
        first_name: "Bob",
        last_name: "Jones",
        phone: "15550001111",
      }),
      user({ user_id: "3", username: "charlie", first_name: "Charlie", last_name: "Brown" }),
      user({ user_id: "4", username: null, first_name: "David", last_name: "Alice" }),
    ]);
    const ids = (query: string, limit?: number) =>
      usersCache.search(query, limit).map((found) => found.user_id);

    expect(ids("alice")).toEqual(["1", "4"]);
    expect(ids("Alice Smith")).toEqual(["1"]);
    expect(ids("brow")).toEqual(["3"]);
    expect(ids("555000")).toEqual(["2"]);
    expect(ids("li", 2)).toEqual(["1", "3"]);
    expect(ids("")).toHaveLength(4);
    expect(ids("'; DROP TABLE users_cache; --")).toEqual([]);
    expect(usersCache.count()).toBe(4);
  });
});

describe("ChatsCache", () => {
  let chatsCache: ChatsCache;

  beforeEach(() => {
    chatsCache = createChatsCache(createAccountCacheDb());
  });

  it("writes one row per chat and updates it in place", () => {
    setSystemTime(NOW);
    chatsCache.upsert(chatRow(-1001234567890, "supergroup", { title: "Team Chat" }));
    setSystemTime(NOW + 60_000);
    chatsCache.upsertMany([
      chatRow(-1001234567890, "supergroup", {
        title: "Renamed Chat",
        raw_json: '{"_":"channel","id":1234567890}',
      }),
      chatRow(42, "private"),
    ]);

    expect(chatsCache.count()).toBe(2);
    expect(chatsCache.getById("-1001234567890")).toMatchObject({
      title: "Renamed Chat",
      raw_json: '{"_":"channel","id":1234567890}',
      created_at: NOW,
      updated_at: NOW + 60_000,
    });
    expect(chatsCache.getById("7")).toBeNull();
  });

  it("finds a chat by username with or without @, in any case", () => {
    chatsCache.upsert(chatRow(-1001234567890, "supergroup", { username: "TeamChat" }));

    for (const username of ["teamchat", "@TEAMCHAT", "TeamChat"]) {
      expect(chatsCache.getByUsername(username)?.chat_id).toBe("-1001234567890");
    }
    expect(chatsCache.getByUsername("nobody")).toBeNull();
  });

  it("lists chats newest first or by title, filtered by type, a page at a time", () => {
    chatsCache.upsertMany([
      chatRow(42, "private", { title: "alice", last_message_at: NOW - 1_000 }),
      chatRow(-4001, "group", { title: "Team Chat", last_message_at: NOW - 5_000 }),
      chatRow(-1001234567890, "supergroup", {
        title: "Community",
        last_message_at: NOW - 2_000,
      }),
      chatRow(-1009876543210, "channel", { title: "News", last_message_at: null }),
      chatRow(-4002, "group", { title: "Book Club", last_message_at: NOW }),
    ]);
    const titles = (options?: ListChatsOptions) =>
      chatsCache.list(options).map((chat) => chat.title);

    expect(titles()).toEqual(["Book Club", "alice", "Community", "Team Chat", "News"]);
    expect(titles({ orderBy: "title" })).toEqual([
      "alice",
      "Book Club",
      "Community",
      "News",
      "Team Chat",
    ]);
    expect(titles({ type: "group", orderBy: "title" })).toEqual(["Book Club", "Team Chat"]);
    expect(titles({ type: "" as ChatType })).toHaveLength(5);
    expect(titles({ limit: 2, offset: 2 })).toEqual(["Community", "Team Chat"]);
  });

  it("searches titles and usernames in part: exact username, then exact title, then newest", () => {
    chatsCache.upsertMany([
      chatRow(-1001000000001, "supergroup", {
        title: "Tech Talk",
        username: "tech",
        last_message_at: NOW - 3_000,
      }),
      chatRow(-1001000000002, "channel", {
        title: "Tech News",
        username: "newsdesk",
        last_message_at: NOW,
      }),
      chatRow(-4001, "group", { title: "Work Team", last_message_at: NOW - 2_000 }),
      chatRow(-4002, "group", { title: "Work Team Archive", last_message_at: NOW - 1_000 }),
    ]);
    const titles = (query: string, limit?: number) =>
      chatsCache.search(query, limit).map((chat) => chat.title);

    expect(titles("TECH")).toEqual(["Tech Talk", "Tech News"]);
    expect(titles("newsdesk")).toEqual(["Tech News"]);
    expect(titles("work team")).toEqual(["Work Team", "Work Team Archive"]);
    expect(titles("tech", 1)).toEqual(["Tech Talk"]);
    expect(titles("nonexistent")).toEqual([]);
  });
});
