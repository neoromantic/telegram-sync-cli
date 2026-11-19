import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { tl } from "@mtcute/bun";
import { runCommand } from "citty";

import { dialogToCacheInput } from "./chats/helpers";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesSearch } from "../db/messages-search";
import { createUsersCache } from "../db/users-cache";
import { toLong } from "../utils/long";
import { ALLOWED_CHATS_ENV } from "../config";
import { accountsDb, getAccountCacheDb } from "../db";
import { testAccount, useTestDataDir } from "../test/accounts.test-utils";
import { fakeDialog } from "../test/fake-dialogs.test-utils";
import { assertPeer, expectLongEqual } from "../test/input-peer.test-utils";
import { cell, richTlMessage } from "../test/rich-message.test-utils";
import { guardCommands } from "./access";

let commandCacheDb: Database;
let secondCacheDb: Database;
type Reply = () => Promise<unknown>;
const commandReplies: Reply[] = [];
const secondReplies: Reply[] = [];
const scriptedCall = (replies: Reply[]) =>
  mock(async (_request: unknown) => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected API call");
    return reply();
  });
const commandCall = scriptedCall(commandReplies);
const secondCall = scriptedCall(secondReplies);
let commandClient = { call: commandCall };
let secondClient = { call: secondCall };
const getClientForAccount = mock((accountId: number) =>
  accountId === 2 ? secondClient : commandClient,
);
mock.module("../services/telegram", () => ({ getClientForAccount }));

function createTestUser(overrides = {}) {
  return {
    user_id: "123456",
    username: "testuser",
    first_name: "Test",
    last_name: "User",
    phone: "1234567890",
    access_hash: "9876543210",
    is_contact: 1,
    is_bot: 0,
    is_premium: 0,
    fetched_at: Date.now(),
    raw_json: JSON.stringify({ id: 123456, first_name: "Test" }),
    ...overrides,
  };
}

describe("send command", () => {
  useTestDataDir([testAccount(), testAccount({ phone: "+15550000002", is_active: false })]);

  beforeEach(() => {
    commandCacheDb = getAccountCacheDb(1);
    secondCacheDb = getAccountCacheDb(2);
    commandCall.mockClear();
    commandReplies.length = 0;
    secondCall.mockClear();
    secondReplies.length = 0;
    getClientForAccount.mockClear();
    commandClient = { call: commandCall };
    secondClient = { call: secondCall };
  });

  const sentUpdates = async () => ({
    _: "updates",
    updates: [],
    users: [],
    chats: [],
    date: 1_760_000_000,
    seq: 0,
  });

  const apiActivity = (db: Database) => db.query("SELECT method, success FROM api_activity").all();

  it("sends from the account --account selects, with that account's access hash", async () => {
    createUsersCache(commandCacheDb).upsert(createTestUser({ access_hash: "111" }));
    createUsersCache(secondCacheDb).upsert(createTestUser({ access_hash: "222" }));
    secondReplies.push(sentUpdates);
    const { sendCommand } = await import("./send");
    const run = sendCommand.run as (input: { args: Record<string, unknown> }) => Promise<void>;
    const logSpy = spyOn(console, "log");

    try {
      await run({
        args: {
          to: "123456",
          message: "hi",
          account: "2",
          silent: false,
          _: [],
        },
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(getClientForAccount.mock.calls).toEqual([[2]]);
    expect(commandCall).not.toHaveBeenCalled();
    expect(secondCall).toHaveBeenCalledTimes(1);
    const request = secondCall.mock.calls[0]?.[0] as {
      _: string;
      peer: tl.TypeInputPeer;
    };
    expect(request._).toBe("messages.sendMessage");
    assertPeer(request.peer, "inputPeerUser");
    expect(request.peer.userId).toBe(123456);
    expectLongEqual(request.peer.accessHash, "222");
    expect(apiActivity(secondCacheDb)).toEqual([{ method: "messages.sendMessage", success: 1 }]);
    expect(apiActivity(commandCacheDb)).toEqual([]);
  });

  it("rejects a bare ID that names a cached group and a cached channel with INVALID_ARGS", async () => {
    createChatsCache(commandCacheDb).upsertMany(
      [
        fakeDialog({ kind: "group", id: 4242, title: "Book Club" }),
        fakeDialog({ kind: "channel", id: 4242, title: "Example News" }),
      ].map(dialogToCacheInput),
    );
    const { sendCommand } = await import("./send");
    const run = sendCommand.run as (input: { args: Record<string, unknown> }) => Promise<void>;
    const errorSpy = spyOn(console, "error");

    try {
      await expect(
        run({ args: { to: "4242", message: "hi", silent: false, _: [] } }),
      ).rejects.toMatchObject({
        code: "INVALID_ARGS",
        details: { to: "4242", candidates: [-4242, -1000000004242] },
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(commandCall).not.toHaveBeenCalled();
  });

  type SendRun = (input: { args: Record<string, unknown> }) => Promise<void>;
  type SentData = {
    messageId: number | null;
    replyTo: number | null;
    silent: boolean;
    format: string | null;
  };

  const sendTo4242 = async (args: string[], reply?: tl.TypeUpdates) => {
    const sent = reply ?? (await sentUpdates());
    commandReplies.push(async () => sent);
    const { sendCommand } = await import("./send");
    const logSpy = spyOn(console, "log");
    let printed: string;
    try {
      await runCommand(sendCommand, { rawArgs: ["--to", "4242", ...args] });
      printed = String(logSpy.mock.calls[0]?.[0]);
    } finally {
      logSpy.mockRestore();
    }
    return {
      request: commandCall.mock.calls[0]?.[0] as tl.messages.RawSendMessageRequest,
      data: JSON.parse(printed).data as SentData,
    };
  };

  const table = "# Prices\n\n| Item | Price |\n|:-----|------:|\n| Tea | 3 |";

  it("sends --markdown as a rich message Telegram parses, with no text", async () => {
    const { request, data } = await sendTo4242(["-m", table, "--markdown"]);

    expect(request.message).toBe("");
    expect(request.richMessage).toEqual({
      _: "inputRichMessageMarkdown",
      markdown: table,
    });
    expect(data.format).toBe("markdown");
  });

  it("sends --html as a rich message", async () => {
    const html = "<table><tr><td>Tea</td></tr></table>";
    const message = richTlMessage({ _: "peerUser", userId: 4242 }, 17, [
      {
        _: "pageBlockTable",
        title: { _: "textEmpty" },
        rows: [{ _: "pageTableRow", cells: [cell("Tea")] }],
      },
    ]);
    const { request, data } = await sendTo4242(["-m", html, "--html"], {
      _: "updates",
      users: [],
      chats: [],
      date: message.date,
      seq: 1,
      updates: [{ _: "updateNewMessage", message, pts: 1, ptsCount: 1 }],
    });
    expect(createMessagesSearch(commandCacheDb).search("Tea")[0]?.text).toContain("| Tea |");
    expect(commandCall).toHaveBeenCalledTimes(1);

    expect(request.message).toBe("");
    expect(request.richMessage).toEqual({ _: "inputRichMessageHTML", html });
    expect(data).toMatchObject({ format: "html", messageId: 17 });
  });

  it("sends plain text to user 4242, not basic group 4242, silent and as a reply", async () => {
    const { request, data } = await sendTo4242([
      "-m",
      "**not bold**",
      "--silent",
      "--reply-to",
      "9",
    ]);

    expect(request).toMatchObject({
      _: "messages.sendMessage",
      peer: { _: "inputPeerUser", userId: 4242, accessHash: toLong(0) },
      message: "**not bold**",
      silent: true,
      replyTo: { _: "inputReplyToMessage", replyToMsgId: 9 },
    });
    expect(request.richMessage).toBeUndefined();
    expect(data).toMatchObject({ format: null, silent: true, replyTo: 9 });
  });

  it("keeps a local recipient error even when the address contains an RPC name", async () => {
    const { sendCommand } = await import("./send");
    const stderr = spyOn(console, "error");
    try {
      await expect(
        runCommand(sendCommand, {
          rawArgs: ["--to", "+RICH_MESSAGE_EMPTY", "--html", "-m", "hi"],
        }),
      ).rejects.toThrow("Invalid peer identifier");
      expect(commandCall).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("explains a RICH_MESSAGE_ error from Telegram", async () => {
    const rpcError = tl.RpcError.fromTl({
      _: "rpc_error",
      errorCode: 400,
      errorMessage: "RICH_MESSAGE_UNSUPPORTED",
    });
    commandReplies.push(async () => {
      throw rpcError;
    });
    const { sendCommand } = await import("./send");
    const errorSpy = spyOn(console, "error");
    try {
      await expect(
        (sendCommand.run as SendRun)({
          args: { to: "4242", message: table, markdown: true, _: [] },
        }),
      ).rejects.toMatchObject({
        code: "TELEGRAM_ERROR",
        details: { telegramError: "RICH_MESSAGE_UNSUPPORTED" },
        retryable: false,
        suggestion: expect.stringContaining("plain text"),
      });
    } finally {
      errorSpy.mockRestore();
    }
  });

  const resolvedTo = (id: number, accessHash: string) => ({
    _: "contacts.resolvedPeer",
    peer: { _: "peerUser", userId: id },
    users: [
      { _: "user", id, accessHash: toLong(accessHash), firstName: "Test", username: "testuser" },
    ],
    chats: [],
  });
  const NEW_OWNER = 654321;
  const requests = () => commandCall.mock.calls.map(([request]) => (request as { _: string })._);

  it("sends to the user who holds @username now, not its previous owner in the cache", async () => {
    createUsersCache(commandCacheDb).upsert(createTestUser({ fetched_at: 1 }));
    commandReplies.push(async () => resolvedTo(654321, "555"), sentUpdates);
    const { sendCommand } = await import("./send");
    const logSpy = spyOn(console, "log");
    try {
      await runCommand(sendCommand, { rawArgs: ["--to", "@testuser", "-m", "hi"] });
    } finally {
      logSpy.mockRestore();
    }

    expect(requests()).toEqual(["contacts.resolveUsername", "messages.sendMessage"]);
    const sent = commandCall.mock.calls[1]?.[0] as tl.messages.RawSendMessageRequest;
    assertPeer(sent.peer, "inputPeerUser");
    expect(sent.peer.userId).toBe(654321);
    expect(createUsersCache(commandCacheDb).getByUsername("testuser")?.user_id).toBe("654321");
  });

  it("sends to the chat and account allowedChats checked, even when both move before it runs", async () => {
    const users = createUsersCache(commandCacheDb);
    users.upsert(createTestUser({ access_hash: "111" }));
    const owner = async () => resolvedTo(123456, "111");
    commandReplies.push(owner, owner, sentUpdates);
    process.env[ALLOWED_CHATS_ENV] = "@testuser";
    const { sendCommand } = await import("./send");
    const send = {
      ...sendCommand,
      run: (context: Parameters<SendRun>[0]) => {
        accountsDb.setActive(2);
        users.upsert(createTestUser({ username: "someoneelse" }));
        users.upsert(createTestUser({ user_id: "654321", access_hash: "555" }));
        return (sendCommand.run as SendRun)(context);
      },
    };
    const tree = { subCommands: { send } };
    guardCommands(tree);
    const logSpy = spyOn(console, "log");
    try {
      await runCommand(tree, { rawArgs: ["send", "--to", "@testuser", "-m", "hi"] });
    } finally {
      logSpy.mockRestore();
      delete process.env[ALLOWED_CHATS_ENV];
    }

    expect(secondCall).not.toHaveBeenCalled();
    expect(requests()).toEqual([
      "contacts.resolveUsername",
      "contacts.resolveUsername",
      "messages.sendMessage",
    ]);
    const sent = commandCall.mock.calls[2]?.[0] as tl.messages.RawSendMessageRequest;
    assertPeer(sent.peer, "inputPeerUser");
    expect(sent.peer.userId).toBe(123456);
    expectLongEqual(sent.peer.accessHash, "111");
  });

  describe("allowedChats by @username after the username moved", () => {
    const resolvedToChannel = async () => ({
      _: "contacts.resolvedPeer",
      peer: { _: "peerChannel", channelId: 777 },
      users: [],
      chats: [
        {
          _: "channel",
          id: 777,
          accessHash: toLong("888"),
          title: "Example News",
          username: "testuser",
          photo: { _: "chatPhotoEmpty" },
          date: 1_700_000_000,
        },
      ],
    });

    beforeEach(() => {
      createUsersCache(commandCacheDb).upsert(createTestUser({ fetched_at: 1 }));
      process.env[ALLOWED_CHATS_ENV] = "@testuser";
    });

    async function guardedSend(to: string) {
      const { sendCommand } = await import("./send");
      const tree = { subCommands: { send: { ...sendCommand } } };
      guardCommands(tree);
      const logSpy = spyOn(console, "log");
      const errorSpy = spyOn(console, "error");
      try {
        await runCommand(tree, { rawArgs: ["send", "--to", to, "-m", "hi"] });
        return null;
      } catch (err) {
        return (err as { code?: string }).code ?? String(err);
      } finally {
        logSpy.mockRestore();
        errorSpy.mockRestore();
        delete process.env[ALLOWED_CHATS_ENV];
      }
    }

    it("refuses its previous owner by ID", async () => {
      commandReplies.push(async () => resolvedTo(NEW_OWNER, "555"), sentUpdates);

      expect(await guardedSend("123456")).toBe("CHAT_NOT_ALLOWED");
      expect(requests()).not.toContain("messages.sendMessage");
    });

    it("sends to the chat that holds it now, though a user keeps it in the cache", async () => {
      commandReplies.push(resolvedToChannel, resolvedToChannel, sentUpdates);

      expect(await guardedSend("@testuser")).toBe(null);
      const sent = commandCall.mock.calls.at(-1)?.[0] as tl.messages.RawSendMessageRequest;
      expect(sent._).toBe("messages.sendMessage");
      assertPeer(sent.peer, "inputPeerChannel");
      expect(sent.peer.channelId).toBe(777);
    });
  });
});
