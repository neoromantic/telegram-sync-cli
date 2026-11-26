import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { takePartIn } from "./participation.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import type { DeleteMessagesResult } from "../commands/messages/delete-messages";
import { parseRawMessage } from "../daemon/sync-worker-real-helpers";
import { createChatsCache } from "../db/chats-cache";
import { createHistoryRanges } from "../db/history-ranges";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import type { MessageSearchItem } from "../types";
import { toPeerIdFromRawPeer } from "../utils/telegram-peer-ids";
import { type CliOptions, NO_CREDENTIALS, runCli } from "./cli.test-utils";
import {
  FAKE_CLIENT_CALL,
  FAKE_CLIENT_CLI,
  FAKE_GONE_MESSAGE,
  FAKE_KEPT_MESSAGE,
  FAKE_SELF_ID,
  FAKE_UNCHECKABLE_MESSAGE,
  FAKE_UNDELETABLE_MESSAGE,
} from "./fake-client-cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const ALICE_ID = 10;
const BOB_ID = 20;
const BOOK_CLUB_ID = -4242;
const TEAM_ID = -1001234567890;

type RawPeer =
  | { _: "peerUser"; userId: number }
  | { _: "peerChat"; chatId: number }
  | { _: "peerChannel"; channelId: number };

const SELF_PEER: RawPeer = { _: "peerUser", userId: FAKE_SELF_ID };
const ALICE_PEER: RawPeer = { _: "peerUser", userId: ALICE_ID };
const BOB_PEER: RawPeer = { _: "peerUser", userId: BOB_ID };
const BOOK_CLUB_PEER: RawPeer = { _: "peerChat", chatId: 4242 };
const TEAM_PEER: RawPeer = { _: "peerChannel", channelId: 1234567890 };

function message(peer: RawPeer, id: number, text: string) {
  return parseRawMessage(
    {
      _: "message",
      id,
      out: true,
      peerId: peer,
      fromId: SELF_PEER,
      message: text,
      date: 1_760_000_000,
    },
    toPeerIdFromRawPeer(peer) as number,
  ) as NonNullable<ReturnType<typeof parseRawMessage>>;
}

function seed(db: Database) {
  for (const [id, username] of [
    [ALICE_ID, "alice"],
    [BOB_ID, "bob"],
  ] as const) {
    createUsersCache(db).upsert({
      user_id: String(id),
      username,
      first_name: username,
      last_name: null,
      access_hash: "777",
      fetched_at: Date.now(),
      raw_json: "{}",
    });
  }
  createChatsCache(db).upsertMany(
    [
      fakeDialog({ kind: "user", id: ALICE_ID, username: "alice" }),
      fakeDialog({ kind: "user", id: BOB_ID, username: "bob" }),
      fakeDialog({
        kind: "supergroup",
        id: 1234567890,
        title: "Team Chat",
        username: "teamchat",
      }),
      fakeDialog({ kind: "group", id: 4242, title: "Book Club" }),
    ].map(dialogToCacheInput),
  );
  takePartIn(db, TEAM_ID, BOOK_CLUB_ID);
  createMessagesCache(db).upsertBatch([
    message(ALICE_PEER, FAKE_UNDELETABLE_MESSAGE, "Alice joined the chat."),
    message(ALICE_PEER, 12, "See you at nine."),
    message(ALICE_PEER, 13, "Bring the tickets."),
    message(BOB_PEER, 40, "Lunch on Friday?"),
    message(TEAM_PEER, 25, "The build is green."),
    message(TEAM_PEER, FAKE_GONE_MESSAGE, "Deploying now."),
    message(TEAM_PEER, FAKE_KEPT_MESSAGE, "Deploy finished."),
    message(BOOK_CLUB_PEER, 3, "Chapter five next."),
    message(SELF_PEER, 7, "Buy oat milk."),
  ]);
  createHistoryRanges(db).recordPage(ALICE_ID, [FAKE_UNDELETABLE_MESSAGE, 12, 13], {
    reachedStart: true,
  });
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}

function errorJson(stderr: string) {
  return JSON.parse(stderr.slice(stderr.indexOf("{\n"))) as ErrorJson;
}

describe("E2E: messages delete", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("messages-delete");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: FAKE_SELF_ID, is_active: true }]);
    seed(env.openCacheDb(1));
  });

  afterEach(() => {
    env.cleanup();
  });

  const offline = () => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  });
  const fake = () => ({
    ...env.getCliOptions(),
    entry: FAKE_CLIENT_CLI,
  });

  function remove(chat: string, ids: number[], extra: string[] = [], options: CliOptions = fake()) {
    return runCli(
      [
        "messages",
        "delete",
        "--chat",
        chat,
        ...ids.flatMap((id) => ["--id", String(id)]),
        ...extra,
      ],
      options,
    );
  }

  async function listed(chat: string, extra: string[] = []) {
    const result = await runCli(["messages", "list", "--chat", chat, ...extra], offline());
    expect(result.exitCode).toBe(0);
    return (result.json as { data: { items: MessageSearchItem[] } }).data.items.map(
      (item) => item.messageId,
    );
  }

  async function searched(query: string, extra: string[] = []) {
    const result = await runCli(["messages", "search", "--query", query, ...extra], offline());
    expect(result.exitCode).toBe(0);
    return (result.json as { data: { results: MessageSearchItem[] } }).data.results.map(
      (item) => item.messageId,
    );
  }

  const deleteCalls = (stderr: string) =>
    stderr
      .split("\n")
      .filter((line) => line.startsWith(FAKE_CLIENT_CALL))
      .map((line) => JSON.parse(line.slice(FAKE_CLIENT_CALL.length + 1)))
      .filter((call) => String(call.method).endsWith(".deleteMessages"));

  it("deletes for this account only, after checking the IDs are in the chat", async () => {
    const result = await remove("@alice", [12]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "messages.getMessages", id: [12] })}`,
    );
    expect(deleteCalls(result.stderr)).toEqual([
      { method: "messages.deleteMessages", id: [12], revoke: false },
    ]);
    expect((result.json as { data: DeleteMessagesResult }).data).toEqual({
      chatId: ALICE_ID,
      messageIds: [12],
      deletedCount: 1,
      deletedIds: [12],
      unverifiedIds: [],
      forEveryone: false,
    });
  });

  it.each([["--revoke"], ["--revoke=true"]])("deletes for everyone with %s", async (flag) => {
    const result = await remove("@alice", [12], [flag]);

    expect(result.exitCode).toBe(0);
    expect(deleteCalls(result.stderr)).toEqual([
      { method: "messages.deleteMessages", id: [12], revoke: true },
    ]);
    expect((result.json as { data: DeleteMessagesResult }).data.forEveryone).toBe(true);
  });

  it.each([[["--revoke=false"]], [["--no-revoke"]], [["--format", "pretty"]], [["-f", "pretty"]]])(
    "deletes for this account only with %j",
    async (flags: string[]) => {
      const result = await remove("@alice", [12], flags);

      expect(result.exitCode).toBe(0);
      expect(deleteCalls(result.stderr)).toEqual([
        { method: "messages.deleteMessages", id: [12], revoke: false },
      ]);
    },
  );

  it.each([["--revoke=no"], ["--revoke=0"]])(
    "refuses %s before it calls Telegram",
    async (flag) => {
      const result = await remove("@alice", [12], [flag]);

      expect(result.exitCode).toBe(3);
      expect(result.stderr).not.toContain(FAKE_CLIENT_CALL);
      expect(errorJson(result.stderr).error.code).toBe("INVALID_ARGS");
      expect(await listed("@alice")).toEqual([13, 12, FAKE_UNDELETABLE_MESSAGE]);
    },
  );

  it("refuses an empty ID list before it calls Telegram", async () => {
    const result = await runCli(["messages", "delete", "--chat", "@alice", "--no-id"], fake());

    expect(result.exitCode).toBe(3);
    expect(result.stderr).not.toContain(FAKE_CLIENT_CALL);
    expect(errorJson(result.stderr).error.code).toBe("INVALID_ARGS");
  });

  it("deletes several IDs at once, each only once, and hides them from the cache", async () => {
    const result = await remove("@alice", [12, 13, 12]);

    expect(result.exitCode).toBe(0);
    expect(deleteCalls(result.stderr)).toEqual([
      { method: "messages.deleteMessages", id: [12, 13], revoke: false },
    ]);
    expect((result.json as { data: DeleteMessagesResult }).data).toMatchObject({
      messageIds: [12, 13],
      deletedCount: 2,
    });

    expect(await listed("@alice")).toEqual([FAKE_UNDELETABLE_MESSAGE]);
    expect(await listed("@alice", ["--includeDeleted"])).toEqual([
      13,
      12,
      FAKE_UNDELETABLE_MESSAGE,
    ]);
    expect(await searched("tickets")).toEqual([]);
    expect(await searched("tickets", ["--includeDeleted"])).toEqual([13]);
  });

  it("deletes in a supergroup for everyone, scoped to it", async () => {
    const result = await remove("@teamchat", [25]);

    expect(result.exitCode).toBe(0);
    expect(deleteCalls(result.stderr)).toEqual([{ method: "channels.deleteMessages", id: [25] }]);
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "channels.getMessages", id: [25] })}`,
    );
    expect((result.json as { data: DeleteMessagesResult }).data).toEqual({
      chatId: TEAM_ID,
      messageIds: [25],
      deletedCount: 1,
      deletedIds: [25],
      unverifiedIds: [],
      forEveryone: true,
    });
    expect(await searched("green")).toEqual([]);
  });

  it("reports what Telegram counted and hides only the messages that are gone", async () => {
    const ids = [25, FAKE_KEPT_MESSAGE];
    const result = await remove("@teamchat", ids);

    expect(result.exitCode).toBe(0);
    expect((result.json as { data: DeleteMessagesResult }).data).toEqual({
      chatId: TEAM_ID,
      messageIds: ids,
      deletedCount: 1,
      deletedIds: [25],
      unverifiedIds: [],
      forEveryone: true,
    });
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "channels.getMessages", id: ids })}`,
    );
    expect(await searched("green")).toEqual([]);
    expect(await searched("finished")).toEqual([FAKE_KEPT_MESSAGE]);
  });

  it("refuses an ID a supergroup does not have, and deletes nothing", async () => {
    const result = await remove("@teamchat", [25, FAKE_GONE_MESSAGE]);

    expect(result.exitCode).toBe(5);
    expect(deleteCalls(result.stderr)).toEqual([]);
    expect(errorJson(result.stderr).error).toEqual({
      code: "TELEGRAM_ERROR",
      message: `Chat ${TEAM_ID} has no message ${FAKE_GONE_MESSAGE}: nothing was deleted`,
      details: { chatId: TEAM_ID, missingIds: [FAKE_GONE_MESSAGE] },
      retryable: false,
    });
    expect(await searched("green")).toEqual([25]);
    expect(await searched("Deploying")).toEqual([FAKE_GONE_MESSAGE]);
  });

  it("succeeds with the IDs unverified and the cache unchanged when the check after the delete fails", async () => {
    const ids = [25, FAKE_UNCHECKABLE_MESSAGE];
    const result = await remove("@teamchat", ids);

    expect(result.exitCode).toBe(0);
    expect(deleteCalls(result.stderr)).toEqual([{ method: "channels.deleteMessages", id: ids }]);
    expect((result.json as { data: DeleteMessagesResult }).data).toEqual({
      chatId: TEAM_ID,
      messageIds: ids,
      deletedCount: 2,
      deletedIds: [],
      unverifiedIds: ids,
      forEveryone: true,
    });
    expect(await searched("green")).toEqual([25]);
  });

  it.each([
    ["Saved Messages", "me", FAKE_SELF_ID, 7, "oat"],
    ["basic group", String(BOOK_CLUB_ID), BOOK_CLUB_ID, 3, "chapter"],
  ])("deletes in %s", async (_kind, chat, chatId, id, word) => {
    const result = await remove(chat, [id]);

    expect(result.exitCode).toBe(0);
    expect((result.json as { data: DeleteMessagesResult }).data).toMatchObject({
      chatId,
      messageIds: [id],
      deletedCount: 1,
      deletedIds: [id],
    });
    expect(await searched(word)).toEqual([]);
  });

  it("refuses IDs of another chat or of no message, and deletes nothing", async () => {
    const result = await remove("@alice", [12, 40, 404]);

    expect(result.exitCode).toBe(5);
    expect(deleteCalls(result.stderr)).toEqual([]);
    expect(errorJson(result.stderr).error).toEqual({
      code: "TELEGRAM_ERROR",
      message: `Chat ${ALICE_ID} has no messages 40, 404: nothing was deleted`,
      details: { chatId: ALICE_ID, missingIds: [40, 404] },
      retryable: false,
    });
    expect(await listed("@alice")).toEqual([13, 12, FAKE_UNDELETABLE_MESSAGE]);
    expect(await searched("lunch")).toEqual([40]);
  });

  it("reports Telegram's refusal and leaves the cache as it was", async () => {
    const result = await remove("@alice", [12, FAKE_UNDELETABLE_MESSAGE]);

    expect(result.exitCode).toBe(5);
    expect(errorJson(result.stderr).error).toEqual({
      code: "TELEGRAM_ERROR",
      message: "Telegram refused to delete one of these messages, most likely a service message",
      details: {
        chatId: ALICE_ID,
        messageIds: [12, FAKE_UNDELETABLE_MESSAGE],
        telegramError: "MESSAGE_DELETE_FORBIDDEN",
      },
      retryable: false,
    });
    expect(await listed("@alice")).toEqual([13, 12, FAKE_UNDELETABLE_MESSAGE]);
  });

  it("refuses a bad --id and more than 100 IDs before it needs Telegram", async () => {
    const badId = await runCli(
      ["messages", "delete", "--chat", "@alice", "--id", "12", "--id", "0"],
      offline(),
    );
    expect(badId.exitCode).toBe(3);
    expect(badId.stderr).toContain("Invalid --id: 0");

    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const tooMany = await remove("@alice", ids, [], offline());
    expect(tooMany.exitCode).toBe(3);
    expect((tooMany.json as ErrorJson).error).toMatchObject({
      code: "INVALID_ARGS",
      details: { count: 101, max: 100 },
    });
  });

  it("needs Telegram", async () => {
    const result = await remove("@alice", [12], [], offline());

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("TELEGRAM_API_ID");
    expect(await listed("@alice")).toEqual([13, 12, FAKE_UNDELETABLE_MESSAGE]);
  });
});
