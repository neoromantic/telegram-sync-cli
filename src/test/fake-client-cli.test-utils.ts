import type { GetHistoryRequest } from "./fake-history.test-utils";

/** This file, to pass as runCli's `entry` */
export const FAKE_CLIENT_CLI = import.meta.path;

export const FAKE_CLIENT_DESTROYED = "fake client: destroyed";

export const FAKE_CLIENT_CALL = "fake client: call";

/** Comma-separated message IDs that every chat's history holds behind the fake client */
export const FAKE_HISTORY_ENV = "FAKE_HISTORY_IDS";

/** The newest message of every chat the fake client reads */
export const FAKE_TOP_MESSAGE = 30;

/** The account the fake client is signed in as */
export const FAKE_SELF_ID = 999;

/** A message of someone else: messages.editMessage refuses it */
export const FAKE_FOREIGN_MESSAGE = 14;
/** A message that holds a file, in Saved Messages and in every channel */
export const FAKE_FILE_MESSAGE = 16;

export const FAKE_MESSAGE_DATE = 1_760_000_000;

export const FAKE_EDIT_DATE = 1_760_003_600;

/** The method Telegram answers with FLOOD_WAIT_<FAKE_FLOOD_SECONDS> */
export const FAKE_FLOOD_METHOD = "help.getNearestDc";

export const FAKE_FLOOD_SECONDS = 42;

const FAKE_USERNAMES: Record<string, { users: object[]; chats: object[] }> = {
  alice: {
    users: [{ _: "user", id: 10, accessHash: 777, firstName: "Alice", username: "alice" }],
    chats: [],
  },
  teamchat: {
    users: [],
    chats: [
      {
        _: "channel",
        id: 1234567890,
        accessHash: 777,
        title: "Team Chat",
        username: "teamchat",
        megagroup: true,
        photo: { _: "chatPhotoEmpty" },
        date: 1_700_000_000,
      },
    ],
  },
};

/** Methods Telegram fails on its side, with the error code and text */
export const FAKE_INTERNAL_ERRORS: Record<string, [number, string]> = {
  "help.getAppConfig": [500, "INTERNAL"],
  "help.getCdnConfig": [-503, "Timeout"],
};

/** A made-up help.getConfig result */
export const FAKE_CONFIG = {
  _: "config",
  date: 1700000000,
  expires: 1700003600,
  testMode: false,
  thisDc: 2,
  dcOptions: [],
  chatSizeMax: 200,
};

interface FakeInputPeer {
  _: string;
  userId?: number;
  chatId?: number;
  channelId?: number;
}

function fakePeer(peer: FakeInputPeer | undefined) {
  if (peer?._ === "inputPeerChannel") {
    return { _: "peerChannel", channelId: peer.channelId };
  }
  if (peer?._ === "inputPeerChat") {
    return { _: "peerChat", chatId: peer.chatId };
  }
  return { _: "peerUser", userId: peer?.userId ?? FAKE_SELF_ID };
}

if (import.meta.main) {
  const { mock } = await import("bun:test");
  const { tl } = await import("@mtcute/bun");
  const telegram = await import("../services/telegram");
  const { paragraph, richMessage } = await import("./rich-message.test-utils");
  const { historyPage } = await import("./fake-history.test-utils");
  const historyIds = (process.env[FAKE_HISTORY_ENV] ?? "").split(",").filter(Boolean).map(Number);

  setInterval(() => {}, 60_000);
  let readMaxId = 0;
  const client = {
    async call(request: {
      _: string;
      maxId?: number;
      username?: string;
      id?: number | { id: number }[];
      message?: string;
      richMessage?: { _: string; markdown?: string; html?: string };
      peer?: FakeInputPeer;
      channel?: { channelId: number };
    }) {
      if (request._ === "help.getConfig") return FAKE_CONFIG;
      if (request._ === "messages.getHistory") {
        return {
          ...historyPage(historyIds, request as GetHistoryRequest),
          chats: [],
          users: [],
        };
      }
      const owner = FAKE_USERNAMES[request.username ?? ""];
      if (request._ === "contacts.resolveUsername" && owner) {
        return { _: "contacts.resolvedPeer", ...owner };
      }
      if (
        (request._ === "messages.getMessages" || request._ === "channels.getMessages") &&
        Array.isArray(request.id)
      ) {
        return {
          _: "messages.messages",
          messages: request.id.map(({ id }) =>
            id === FAKE_FILE_MESSAGE
              ? {
                  _: "message",
                  id,
                  out: true,
                  peerId: request.channel
                    ? { _: "peerChannel", channelId: request.channel.channelId }
                    : { _: "peerUser", userId: FAKE_SELF_ID },
                  date: FAKE_MESSAGE_DATE,
                  message: "Notes from Monday",
                  media: {
                    _: "messageMediaDocument",
                    document: { _: "document", mimeType: "text/plain", attributes: [] },
                  },
                }
              : { _: "messageEmpty", id },
          ),
          chats: [],
          users: [],
        };
      }
      if (request._ === "messages.editMessage") {
        console.error(
          `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: request._, id: request.id, message: request.message, rich: request.richMessage?._ })}`,
        );
        if (request.id === FAKE_FOREIGN_MESSAGE) {
          throw tl.RpcError.fromTl({
            _: "rpc_error",
            errorCode: 403,
            errorMessage: "MESSAGE_AUTHOR_REQUIRED",
          });
        }
        const channel = request.peer?._ === "inputPeerChannel";
        return {
          _: "updates",
          updates: [
            {
              _: channel ? "updateEditChannelMessage" : "updateEditMessage",
              message: {
                _: "message",
                id: request.id,
                out: true,
                peerId: fakePeer(request.peer),
                fromId: { _: "peerUser", userId: FAKE_SELF_ID },
                date: FAKE_MESSAGE_DATE,
                editDate: FAKE_EDIT_DATE,
                message: request.message ?? "",
                richMessage: request.richMessage
                  ? richMessage([
                      paragraph(request.richMessage.markdown ?? request.richMessage.html ?? ""),
                    ])
                  : undefined,
              },
              pts: 1,
              ptsCount: 1,
            },
          ],
          users: [],
          chats: [],
          date: FAKE_EDIT_DATE,
          seq: 0,
        };
      }
      if (request._ === "messages.readHistory" || request._ === "channels.readHistory") {
        console.error(
          `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: request._, maxId: request.maxId })}`,
        );
        readMaxId = request.maxId ?? 0;
        return request._ === "channels.readHistory"
          ? true
          : { _: "messages.affectedMessages", pts: 1, ptsCount: 1 };
      }
      if (request._ === "messages.getPeerDialogs") {
        const boundary = readMaxId || FAKE_TOP_MESSAGE;
        return {
          _: "messages.peerDialogs",
          dialogs: [
            {
              _: "dialog",
              peer: { _: "peerUser", userId: 1 },
              topMessage: FAKE_TOP_MESSAGE,
              readInboxMaxId: boundary,
              unreadCount: FAKE_TOP_MESSAGE - boundary,
            },
          ],
          messages: [],
          chats: [],
          users: [],
        };
      }
      if (request._ === FAKE_FLOOD_METHOD) {
        throw tl.RpcError.fromTl({
          _: "rpc_error",
          errorCode: 420,
          errorMessage: `FLOOD_WAIT_${FAKE_FLOOD_SECONDS}`,
        });
      }
      const internal = FAKE_INTERNAL_ERRORS[request._];
      if (internal) {
        throw tl.RpcError.fromTl({
          _: "rpc_error",
          errorCode: internal[0],
          errorMessage: internal[1],
        });
      }
      if (request._ === "messages.sendMessage") {
        throw tl.RpcError.fromTl({
          _: "rpc_error",
          errorCode: 400,
          errorMessage: "PEER_ID_INVALID",
        });
      }
      throw Object.assign(new Error("METHOD_INVALID"), { code: 400 });
    },
    async destroy() {
      await Bun.sleep(20);
      console.error(FAKE_CLIENT_DESTROYED);
    },
  };

  mock.module("../services/telegram", () => ({
    ...telegram,
    getClientForAccount: () => client,
  }));

  await import("../index");
}
