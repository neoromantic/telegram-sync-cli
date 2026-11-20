import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { takePartIn } from "./participation.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import type { EditMessageResult } from "../commands/messages/edit-message";
import { parseRawMessage } from "../daemon/sync-worker-real-helpers";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import { createUsersCache } from "../db/users-cache";
import type { MessageSearchItem } from "../types";
import { toPeerIdFromRawPeer } from "../utils/telegram-peer-ids";
import { type CliOptions, NO_CREDENTIALS, runCli } from "./cli.test-utils";
import {
  FAKE_CLIENT_CALL,
  FAKE_CLIENT_CLI,
  FAKE_EDIT_DATE,
  FAKE_FILE_MESSAGE,
  FAKE_FOREIGN_MESSAGE,
  FAKE_MESSAGE_DATE,
  FAKE_SELF_ID,
} from "./fake-client-cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const ALICE_ID = 10;
const BOOK_CLUB_ID = -4242;
const TEAM_ID = -1001234567890;

const SELF_PEER = { _: "peerUser", userId: FAKE_SELF_ID } as const;
const ALICE_PEER = { _: "peerUser", userId: ALICE_ID } as const;
const TEAM_PEER = { _: "peerChannel", channelId: 1234567890 } as const;

function message(
  peer: typeof SELF_PEER | typeof ALICE_PEER | typeof TEAM_PEER,
  id: number,
  text: string,
  out: boolean,
) {
  const from = out ? SELF_PEER : peer;
  return parseRawMessage(
    {
      _: "message",
      id,
      out,
      peerId: peer,
      fromId: from,
      message: text,
      date: FAKE_MESSAGE_DATE,
    },
    toPeerIdFromRawPeer(peer) as number,
  ) as NonNullable<ReturnType<typeof parseRawMessage>>;
}

function seed(db: Database) {
  createUsersCache(db).upsert({
    user_id: String(ALICE_ID),
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
        id: ALICE_ID,
        title: "Alice",
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
  takePartIn(db, TEAM_ID, BOOK_CLUB_ID);
  createMessagesCache(db).upsertBatch([
    message(ALICE_PEER, 12, "See you at nine.", true),
    message(ALICE_PEER, FAKE_FOREIGN_MESSAGE, "Nine works for me.", false),
    message(TEAM_PEER, 25, "The build is green.", true),
    message(SELF_PEER, 7, "Buy oat milk.", true),
  ]);
}

interface ErrorJson {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}

describe("E2E: messages edit", () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = createTestEnvironment("messages-edit");
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

  function edit(chat: string, id: number, text: string, options: CliOptions = fake()) {
    return runCli(["messages", "edit", "--chat", chat, "--id", String(id), "-m", text], options);
  }

  async function cached(chat: string, id: number) {
    const result = await runCli(["messages", "get", "--chat", chat, "--id", String(id)], offline());
    expect(result.exitCode).toBe(0);
    return (result.json as { data: { message: MessageSearchItem } }).data.message;
  }

  it("replaces the text, prints the edited message and stores it", async () => {
    const result = await edit("@alice", 12, "See you at ten.");

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "messages.editMessage", id: 12, message: "See you at ten." })}`,
    );
    const data = (result.json as { data: EditMessageResult }).data;
    expect(data).toMatchObject({
      chatId: ALICE_ID,
      messageId: 12,
      edited: true,
      message: {
        chatId: ALICE_ID,
        messageId: 12,
        text: "See you at ten.",
        isOutgoing: true,
        isEdited: true,
        editDate: FAKE_EDIT_DATE,
        date: FAKE_MESSAGE_DATE,
        chat: { id: ALICE_ID, username: "alice" },
      },
    });

    expect(await cached("@alice", 12)).toEqual(data.message as MessageSearchItem);
  });

  it("makes the new text searchable and the old one not", async () => {
    await edit("@alice", 12, "See you at ten.");

    const search = async (query: string) => {
      const result = await runCli(["messages", "search", "--query", query], offline());
      expect(result.exitCode).toBe(0);
      return (result.json as { data: { results: MessageSearchItem[] } }).data.results.map(
        (item) => item.messageId,
      );
    };
    expect(await search("ten")).toEqual([12]);
    expect(await search("nine")).toEqual([FAKE_FOREIGN_MESSAGE]);
  });

  it.each([
    ["supergroup", "@teamchat", TEAM_ID, 25],
    ["Saved Messages", "me", FAKE_SELF_ID, 7],
  ])("edits a message in a %s", async (_kind, chat, chatId, id) => {
    const result = await edit(chat, id, "Edited.");

    expect(result.exitCode).toBe(0);
    expect((result.json as { data: EditMessageResult }).data).toMatchObject({
      chatId,
      messageId: id,
      message: { chatId, text: "Edited.", isEdited: true },
    });
    expect((await cached(chat, id)).text).toBe("Edited.");
  });

  it("edits a message the cache does not hold, and stores it", async () => {
    const result = await edit(String(BOOK_CLUB_ID), 3, "Chapter five.");

    expect(result.exitCode).toBe(0);
    expect((await cached(String(BOOK_CLUB_ID), 3)).text).toBe("Chapter five.");
  });

  it("reports Telegram's refusal and leaves the cached message as it was", async () => {
    const result = await edit("@alice", FAKE_FOREIGN_MESSAGE, "Ten then.");

    expect(result.exitCode).toBe(5);
    const json: ErrorJson = JSON.parse(result.stderr.slice(result.stderr.indexOf("{\n")));
    expect(json.error).toEqual({
      code: "TELEGRAM_ERROR",
      message: `You can't edit message ${FAKE_FOREIGN_MESSAGE}: it was sent by someone else`,
      details: {
        chatId: ALICE_ID,
        messageId: FAKE_FOREIGN_MESSAGE,
        telegramError: "MESSAGE_AUTHOR_REQUIRED",
      },
      retryable: false,
    });
    expect(await cached("@alice", FAKE_FOREIGN_MESSAGE)).toMatchObject({
      text: "Nine works for me.",
      isEdited: false,
    });
  });

  it("replaces the message with a rich one for --markdown, and with plain text again", async () => {
    const search = async (query: string) => {
      const found = await runCli(["messages", "search", "--query", query], offline());
      return (found.json as { data: { results: MessageSearchItem[] } }).data.results.map(
        (item) => item.messageId,
      );
    };

    const result = await runCli(
      ["messages", "edit", "--chat", "@alice", "--id", "12", "-m", "Plan for Monday", "--markdown"],
      fake(),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: "messages.editMessage", id: 12, rich: "inputRichMessageMarkdown" })}`,
    );
    expect((result.json as { data: EditMessageResult }).data).toMatchObject({
      messageId: 12,
      format: "markdown",
      message: { text: "Plan for Monday" },
    });
    expect((await cached("@alice", 12)).text).toBe("Plan for Monday");
    expect(await search("Monday")).toEqual([12]);

    await edit("@alice", 12, "See you at ten.");

    expect((await cached("@alice", 12)).text).toBe("See you at ten.");
    expect(await search("Monday")).toEqual([]);
  });

  it.each([
    ["Saved Messages", "me"],
    ["a supergroup", "@teamchat"],
  ])("refuses to make the caption of a file rich in %s", async (_name, chat) => {
    const result = await runCli(
      [
        "messages",
        "edit",
        "--chat",
        chat,
        "--id",
        String(FAKE_FILE_MESSAGE),
        "-m",
        "# Notes",
        "--markdown",
      ],
      fake(),
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("has an attachment: its caption can only be plain text");
    expect(result.stderr).not.toContain('"method":"messages.editMessage"');
  });

  it("refuses --markdown with --html before it needs Telegram", async () => {
    const result = await runCli(
      ["messages", "edit", "--chat", "@alice", "--id", "12", "-m", "Hi.", "--markdown", "--html"],
      offline(),
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("Use --markdown or --html, not both");
  });

  it("refuses an empty text and a bad --id before it needs Telegram", async () => {
    const empty = await edit("@alice", 12, "  ", offline());
    expect(empty.exitCode).toBe(3);
    expect(empty.stderr).toContain("Message text cannot be empty");

    const badId = await runCli(
      ["messages", "edit", "--chat", "@alice", "--id", "12abc", "-m", "Hi."],
      offline(),
    );
    expect(badId.exitCode).toBe(3);
    expect(badId.stderr).toContain("Invalid --id: 12abc");
  });

  it("needs Telegram", async () => {
    const result = await edit("@alice", 12, "See you at ten.", offline());

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain("TELEGRAM_API_ID");
    expect((await cached("@alice", 12)).text).toBe("See you at nine.");
  });
});
