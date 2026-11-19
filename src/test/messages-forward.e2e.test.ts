import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { takePartIn } from "./participation.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import type { ForwardMessagesResult } from "../commands/messages/forward-message";
import { createChatsCache } from "../db/chats-cache";
import { createUsersCache } from "../db/users-cache";
import type { MessageSearchItem } from "../types";
import { type CliOptions, NO_CREDENTIALS, runCli } from "./cli.test-utils";
import {
  FAKE_CLIENT_CALL,
  FAKE_CLIENT_CLI,
  FAKE_MESSAGE_DATE,
  FAKE_PROTECTED_CHANNEL,
  FAKE_SELF_ID,
  FAKE_TOP_MESSAGE,
} from "./fake-client-cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const ALICE_ID = 10;
const BOB_ID = 20;
const TEAM_ID = -1001234567890;
const VAULT_ID = Number(`-100${FAKE_PROTECTED_CHANNEL}`);

const copy = (n: number) => FAKE_TOP_MESSAGE + n;

function seed(db: Database) {
  const users = createUsersCache(db);
  for (const [id, username, name] of [
    [ALICE_ID, "alice", "Alice"],
    [BOB_ID, "bob", "Bob"],
  ] as const) {
    users.upsert({
      user_id: String(id),
      username,
      first_name: name,
      last_name: null,
      access_hash: "777",
      fetched_at: Date.now(),
      raw_json: "{}",
    });
  }
  createChatsCache(db).upsertMany(
    [
      fakeDialog({ kind: "user", id: ALICE_ID, title: "Alice" }),
      fakeDialog({ kind: "user", id: BOB_ID, title: "Bob", username: "bob" }),
      fakeDialog({
        kind: "supergroup",
        id: 1234567890,
        title: "Team Chat",
        username: "teamchat",
      }),
      fakeDialog({
        kind: "channel",
        id: FAKE_PROTECTED_CHANNEL,
        title: "Vault",
        username: "vault",
      }),
    ].map(dialogToCacheInput),
  );
  takePartIn(db, TEAM_ID);
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}

describe("E2E: messages forward", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("messages-forward");
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

  function forward(
    from: string,
    to: string,
    ids: Array<number | string>,
    options: CliOptions = fake(),
  ) {
    return runCli(
      [
        "messages",
        "forward",
        "--from",
        from,
        "--to",
        to,
        ...ids.flatMap((id) => ["--id", String(id)]),
      ],
      options,
    );
  }

  const data = (result: { json?: unknown }) =>
    (result.json as { data: ForwardMessagesResult }).data;

  async function cached(chat: string, id: number) {
    const result = await runCli(["messages", "get", "--chat", chat, "--id", String(id)], offline());
    expect(result.exitCode).toBe(0);
    return (result.json as { data: { message: MessageSearchItem } }).data.message;
  }

  async function searchIds(query: string) {
    const result = await runCli(["messages", "search", "--query", query], {
      ...offline(),
    });
    expect(result.exitCode).toBe(0);
    return (result.json as { data: { results: MessageSearchItem[] } }).data.results
      .map((item) => item.messageId)
      .sort((a, b) => a - b);
  }

  it("forwards a message between private chats and stores the copy", async () => {
    const result = await forward("10", "@bob", [12]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "messages.forwardMessages", id: [12], randomIds: 1 })}`,
    );
    const out = data(result);
    expect(out).toMatchObject({
      fromChatId: ALICE_ID,
      toChatId: BOB_ID,
      forwarded: [
        {
          messageId: 12,
          newMessageId: copy(1),
          message: {
            chatId: BOB_ID,
            messageId: copy(1),
            text: "Forwarded message 12",
            isOutgoing: true,
            forwardFromId: ALICE_ID,
            date: FAKE_MESSAGE_DATE,
            chat: { id: BOB_ID, username: "bob" },
          },
        },
      ],
    });
    expect(await cached("@bob", copy(1))).toEqual(out.forwarded[0]?.message as MessageSearchItem);
  });

  it.each([
    ["a supergroup", "@teamchat", TEAM_ID],
    ["Saved Messages", "me", FAKE_SELF_ID],
  ])("forwards into %s", async (_kind, to, toChatId) => {
    const result = await forward("@bob", to, [7]);

    expect(result.exitCode).toBe(0);
    expect(data(result)).toMatchObject({
      fromChatId: BOB_ID,
      toChatId,
      forwarded: [
        {
          messageId: 7,
          newMessageId: copy(1),
          message: { chatId: toChatId, forwardFromId: BOB_ID },
        },
      ],
    });
    expect((await cached(to, copy(1))).text).toBe("Forwarded message 7");
  });

  it("forwards several IDs in one call and pairs each with its copy", async () => {
    const result = await forward("10", "@bob", [14, 12, 14, 13]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "messages.forwardMessages", id: [14, 12, 13], randomIds: 3 })}`,
    );
    expect(
      data(result).forwarded.map((f) => [f.messageId, f.newMessageId, f.message?.text]),
    ).toEqual([
      [14, copy(3), "Forwarded message 14"],
      [12, copy(1), "Forwarded message 12"],
      [13, copy(2), "Forwarded message 13"],
    ]);
    expect(await searchIds("Forwarded")).toEqual([copy(1), copy(2), copy(3)]);
  });

  it("reports Telegram's refusal and caches nothing", async () => {
    const result = await forward("@vault", "@bob", [12]);

    expect(result.exitCode).toBe(5);
    const json: ErrorJson = JSON.parse(result.stderr.slice(result.stderr.indexOf("{\n")));
    expect(json.error).toEqual({
      code: "TELEGRAM_ERROR",
      message: "The source chat protects its content: Telegram does not allow forwarding from it",
      details: {
        fromChatId: VAULT_ID,
        toChatId: BOB_ID,
        messageIds: [12],
        telegramError: "CHAT_FORWARDS_RESTRICTED",
      },
      retryable: false,
    });
    expect(await searchIds("Forwarded")).toEqual([]);
  });

  it("refuses a bad --id and more than 100 IDs before it needs Telegram", async () => {
    const badId = await forward("10", "@bob", [12, "12abc"], offline());
    expect(badId.exitCode).toBe(3);
    expect(badId.stderr).toContain("Invalid --id: 12abc");

    const ids = Array.from({ length: 101 }, (_, i) => i + 1);
    const tooMany = await forward("10", "@bob", ids, offline());
    expect(tooMany.exitCode).toBe(3);
    expect((tooMany.json as ErrorJson).error).toMatchObject({
      code: "INVALID_ARGS",
      details: { count: 101, max: 100 },
    });
  });

  it("needs --to", async () => {
    const result = await runCli(["messages", "forward", "--from", "10", "--id", "12"], offline());
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("--to");
  });

  it("needs Telegram", async () => {
    const result = await forward("10", "@bob", [12], offline());

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("TELEGRAM_API_ID");
    expect(await searchIds("Forwarded")).toEqual([]);
  });
});
