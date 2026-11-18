/** This file, to pass as runCli's `entry` */
export const FAKE_CLIENT_CLI = import.meta.path;

export const FAKE_CLIENT_DESTROYED = "fake client: destroyed";

export const FAKE_CLIENT_CALL = "fake client: call";

/** The newest message of every chat the fake client reads */
export const FAKE_TOP_MESSAGE = 30;

/** The method Telegram answers with FLOOD_WAIT_<FAKE_FLOOD_SECONDS> */
export const FAKE_FLOOD_METHOD = "help.getNearestDc";

export const FAKE_FLOOD_SECONDS = 42;

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

if (import.meta.main) {
  const { mock } = await import("bun:test");
  const { tl } = await import("@mtcute/bun");
  const telegram = await import("../../services/telegram");

  setInterval(() => {}, 60_000);
  let readMaxId = 0;
  const client = {
    async call(request: { _: string; maxId?: number }) {
      if (request._ === "help.getConfig") return FAKE_CONFIG;
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

  mock.module("../../services/telegram", () => ({
    ...telegram,
    getClientForAccount: () => client,
  }));

  await import("../../index");
}
