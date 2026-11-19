import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { tl } from "@mtcute/bun";

import {
  buildSentMessageInputs,
  cacheSentMessage,
  resolveSelfId,
  type SentMessageRequest,
} from "./sent-message-cache";
import { createTestDatabase } from "../../db";
import { createMessageAttachmentsStore } from "../../db/message-attachments";
import { createMessagesCache } from "../../db/messages-cache";
import { createMessagesSearch } from "../../db/messages-search";
import { extractAttachment } from "../../utils/attachment";
import { toLong } from "../../utils/long";
import { toPeerIdFromInputPeer } from "../../utils/telegram-peer-ids";
import { createAccountCacheDb } from "../../test/cache-db.test-utils";
import { pdfDocumentMessage } from "../../test/media-messages.test-utils";
import { takePartIn } from "../../test/participation.test-utils";
import { assertPeerIdInvariants } from "../../test/peer-id-invariants.test-utils";

const SELF_ID = 5550001;
const OTHER_USER_ID = 5550002;
const GROUP_ID = 4440001;
const GROUP_PEER_ID = -4440001;
const CHANNEL_ID = 3330001;
const CHANNEL_PEER_ID = -1000003330001;
const DATE = 1_760_000_000;

function shortSent(overrides: Partial<tl.RawUpdateShortSentMessage> = {}) {
  const result: tl.RawUpdateShortSentMessage = {
    _: "updateShortSentMessage",
    out: true,
    id: 101,
    pts: 2001,
    ptsCount: 1,
    date: DATE,
    ...overrides,
  };
  return result;
}

function rawMessage(overrides: Partial<tl.RawMessage> = {}) {
  const result: tl.RawMessage = {
    _: "message",
    id: 202,
    out: true,
    peerId: { _: "peerChannel", channelId: CHANNEL_ID },
    fromId: { _: "peerUser", userId: SELF_ID },
    date: DATE,
    message: "hello channel",
    ...overrides,
  };
  return result;
}

function updatesWith(updates: tl.TypeUpdate[], kind: "updates" | "updatesCombined" = "updates") {
  if (kind === "updatesCombined") {
    const result: tl.TypeUpdates = {
      _: "updatesCombined",
      updates,
      users: [],
      chats: [],
      date: DATE,
      seqStart: 0,
      seq: 0,
    };
    return result;
  }
  const result: tl.TypeUpdates = {
    _: "updates",
    updates,
    users: [],
    chats: [],
    date: DATE,
    seq: 0,
  };
  return result;
}

const selfRequest: SentMessageRequest = {
  peer: { _: "inputPeerSelf" },
  text: "note to self",
};

describe("toPeerIdFromInputPeer", () => {
  it("returns marked peer IDs for every input peer type", () => {
    expect(toPeerIdFromInputPeer({ _: "inputPeerSelf" }, SELF_ID)).toBe(SELF_ID);
    expect(toPeerIdFromInputPeer({ _: "inputPeerSelf" }, null)).toBeNull();
    expect(
      toPeerIdFromInputPeer(
        {
          _: "inputPeerUser",
          userId: OTHER_USER_ID,
          accessHash: toLong(1),
        },
        SELF_ID,
      ),
    ).toBe(OTHER_USER_ID);
    expect(toPeerIdFromInputPeer({ _: "inputPeerChat", chatId: GROUP_ID }, null)).toBe(
      GROUP_PEER_ID,
    );
    expect(
      toPeerIdFromInputPeer(
        {
          _: "inputPeerChannel",
          channelId: CHANNEL_ID,
          accessHash: toLong(1),
        },
        null,
      ),
    ).toBe(CHANNEL_PEER_ID);
    expect(toPeerIdFromInputPeer({ _: "inputPeerEmpty" }, SELF_ID)).toBeNull();
  });
});

describe("buildSentMessageInputs", () => {
  describe("updateShortSentMessage", () => {
    it("builds the row from the request for Saved Messages", () => {
      const result = shortSent();
      const [input] = buildSentMessageInputs(result, selfRequest, SELF_ID);

      expect(input).toMatchObject({
        chat_id: SELF_ID,
        message_id: 101,
        from_id: SELF_ID,
        text: "note to self",
        message_type: "text",
        has_media: false,
        is_outgoing: true,
        date: DATE,
        reply_to_id: null,
      });
      expect(JSON.parse(input!.raw_json)).toMatchObject({
        _: "updateShortSentMessage",
        id: 101,
      });
    });

    it("uses a negative ID for a basic group and keeps the reply", () => {
      const [input] = buildSentMessageInputs(
        shortSent({ id: 7 }),
        {
          peer: { _: "inputPeerChat", chatId: GROUP_ID },
          text: "reply",
          replyTo: 5,
        },
        SELF_ID,
      );
      expect(input).toMatchObject({
        chat_id: GROUP_PEER_ID,
        message_id: 7,
        reply_to_id: 5,
      });
    });

    it("records media from the response, such as a link preview", () => {
      const [input] = buildSentMessageInputs(
        shortSent({
          media: {
            _: "messageMediaWebPage",
            webpage: {
              _: "webPage",
              id: toLong(9),
              url: "https://example.com",
              displayUrl: "example.com",
              hash: 0,
            },
          },
        }),
        { ...selfRequest, text: "see https://example.com" },
        SELF_ID,
      );
      expect(input).toMatchObject({ message_type: "webpage", has_media: true });
    });

    it("stores nothing without the own user ID", () => {
      expect(buildSentMessageInputs(shortSent(), selfRequest, null)).toEqual([]);
    });
  });

  describe("updates and updatesCombined", () => {
    it("maps updateNewChannelMessage to a -100… chat ID", () => {
      const message = rawMessage();
      const result = updatesWith([
        { _: "updateMessageID", id: 202, randomId: toLong(1) },
        { _: "updateNewChannelMessage", message, pts: 1, ptsCount: 1 },
      ]);
      const inputs = buildSentMessageInputs(
        result,
        {
          peer: {
            _: "inputPeerChannel",
            channelId: CHANNEL_ID,
            accessHash: toLong(1),
          },
          text: "hello channel",
        },
        null,
      );

      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        chat_id: CHANNEL_PEER_ID,
        message_id: 202,
        from_id: SELF_ID,
        text: "hello channel",
        is_outgoing: true,
        date: DATE,
      });
      expect(JSON.parse(inputs[0]!.raw_json)).toMatchObject({
        _: "message",
        id: 202,
      });
    });

    it("maps updateNewMessage in updatesCombined for a basic group", () => {
      const message = rawMessage({
        id: 303,
        peerId: { _: "peerChat", chatId: GROUP_ID },
        message: "hello group",
      });
      const inputs = buildSentMessageInputs(
        updatesWith([{ _: "updateNewMessage", message, pts: 1, ptsCount: 1 }], "updatesCombined"),
        { peer: { _: "inputPeerChat", chatId: GROUP_ID }, text: "hello group" },
        null,
      );
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({
        chat_id: GROUP_PEER_ID,
        message_id: 303,
      });
    });
  });
});

describe("cacheSentMessage", () => {
  let db: Database;

  beforeEach(() => {
    db = createAccountCacheDb();
    takePartIn(db, CHANNEL_PEER_ID);
  });

  it("upserts the message with fetched_at and makes it searchable", async () => {
    const getSelfId = mock(async () => SELF_ID);
    const before = Date.now();

    const cached = await cacheSentMessage({ cacheDb: db, getSelfId }, shortSent(), {
      ...selfRequest,
      text: "grocery list sendcachemarker",
    });

    expect(cached).toBe(1);
    expect(getSelfId).toHaveBeenCalledTimes(1);
    const row = createMessagesCache(db).get(SELF_ID, 101);
    expect(row?.text).toBe("grocery list sendcachemarker");
    expect(row?.is_outgoing).toBe(1);
    expect(row?.fetched_at).toBeGreaterThanOrEqual(before);
    expect(row?.raw_json).toContain("updateShortSentMessage");

    const results = createMessagesSearch(db).search("sendcachemarker");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ chat_id: SELF_ID, message_id: 101 });
  });

  it("does not look up the own user ID for full updates", async () => {
    const getSelfId = mock(async () => SELF_ID);
    const message = rawMessage();

    const cached = await cacheSentMessage(
      { cacheDb: db, getSelfId },
      updatesWith([{ _: "updateNewChannelMessage", message, pts: 1, ptsCount: 1 }]),
      selfRequest,
    );

    expect(cached).toBe(1);
    expect(getSelfId).not.toHaveBeenCalled();
    expect(createMessagesCache(db).get(CHANNEL_PEER_ID, 202)).not.toBeNull();
    assertPeerIdInvariants(db);
  });

  it("caches a file sent with messages.sendMedia with its attachment row", async () => {
    const message = {
      ...pdfDocumentMessage({ _: "peerUser", userId: SELF_ID }, 42),
      out: true,
      message: "Quarterly numbers",
    };
    const cached = await cacheSentMessage(
      { cacheDb: db, getSelfId: async () => SELF_ID },
      updatesWith([
        { _: "updateMessageID", id: 42, randomId: toLong(1) },
        {
          _: "updateNewMessage",
          message: message as unknown as tl.RawMessage,
          pts: 1,
          ptsCount: 1,
        },
      ]),
      { ...selfRequest, text: "Quarterly numbers" },
    );

    expect(cached).toBe(1);
    expect(createMessagesCache(db).get(SELF_ID, 42)).toMatchObject({
      text: "Quarterly numbers",
      message_type: "document",
      has_media: 1,
    });
    expect(createMessageAttachmentsStore(db).get(SELF_ID, 42)).toMatchObject({
      kind: "document",
      source: "message",
      file_name: "example-report.pdf",
      mime_type: "application/pdf",
      file_size: 120_000,
      unique_file_id: extractAttachment(message)?.uniqueFileId,
    });
  });

  it("swallows a failing cache write or own user ID lookup", async () => {
    const broken = new Database(":memory:");
    const offline = async () => {
      throw new Error("network down");
    };

    expect(
      await cacheSentMessage(
        { cacheDb: broken, getSelfId: async () => SELF_ID },
        shortSent(),
        selfRequest,
      ),
    ).toBe(0);
    expect(
      await cacheSentMessage({ cacheDb: db, getSelfId: offline }, shortSent(), selfRequest),
    ).toBe(0);
    expect(createMessagesCache(db).countByChatId(SELF_ID)).toBe(0);
  });
});

describe("resolveSelfId", () => {
  type MeResult = Awaited<ReturnType<Parameters<typeof resolveSelfId>[0]["getMe"]>>;
  const getMeResult = { id: SELF_ID } as MeResult;

  it("reads the user ID from the account row without calling Telegram", async () => {
    const { accountsDb } = createTestDatabase();
    const account = accountsDb.create({
      phone: "+15550000001",
      user_id: SELF_ID,
      is_active: true,
    });
    const getMe = mock(async () => getMeResult);

    expect(await resolveSelfId({ getMe }, account.id, accountsDb)).toBe(SELF_ID);
    expect(await resolveSelfId({ getMe }, undefined, accountsDb)).toBe(SELF_ID);
    expect(getMe).not.toHaveBeenCalled();
  });

  it("asks Telegram once and saves the user ID when the row lacks it", async () => {
    const { accountsDb } = createTestDatabase();
    const account = accountsDb.create({
      phone: "+15550000001",
      is_active: true,
    });
    const getMe = mock(async () => getMeResult);

    expect(await resolveSelfId({ getMe }, undefined, accountsDb)).toBe(SELF_ID);
    expect(getMe).toHaveBeenCalledTimes(1);
    expect(accountsDb.getById(account.id)?.user_id).toBe(SELF_ID);
  });
});
