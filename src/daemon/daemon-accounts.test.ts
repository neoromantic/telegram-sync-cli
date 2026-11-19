import { describe, expect, it, setSystemTime } from "bun:test";
import type { RpcCallMiddleware, RpcCallMiddlewareContext, tl } from "@mtcute/bun";
import {
  daemonNetworkMiddlewares,
  resolveSyncChatType,
  scheduleReconnect,
  setupSignalHandlers,
} from "./daemon-accounts";
import { floodWaitSecondsOf } from "./daemon-api-activity";
import { type AccountRuntime, requestShutdown } from "./daemon-context";
import { isDaemonStopError } from "./daemon-utils";
import { createSyncPacer } from "./sync-pacing";
import { type AccountConnectionState, DEFAULT_RECONNECT_CONFIG } from "./types";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { testDaemonContext } from "../test/daemon-runtime.test-utils";

describe("reconnect scheduling", () => {
  it("backs off from 5 s, doubling up to 5 minutes, and gives up after 10 attempts", () => {
    const ctx = testDaemonContext({ reconnectConfig: DEFAULT_RECONNECT_CONFIG });
    const accountState: AccountConnectionState = {
      accountId: 2,
      phone: "+15550000002",
      name: null,
      status: "error",
    };
    const now = 1_760_000_000_000;
    const delays: number[] = [];

    setSystemTime(now);
    try {
      for (let attempt = 1; attempt <= 10; attempt++) {
        scheduleReconnect(ctx, accountState);
        delays.push(accountState.nextReconnectAt! - now);
      }
      accountState.nextReconnectAt = undefined;
      scheduleReconnect(ctx, accountState);
    } finally {
      setSystemTime();
    }

    expect(delays).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000, 300_000,
    ]);
    expect(accountState.nextReconnectAt).toBeUndefined();
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Account #2 (+15*******02) exceeded max reconnection attempts (10). Giving up.",
    );
  });
});

describe("resolveSyncChatType", () => {
  it("maps each mtcute chat type to its sync type, an unknown group type to group", () => {
    expect(
      [
        { type: "user" },
        { type: "chat", chatType: "group" },
        { type: "chat", chatType: "supergroup" },
        { type: "chat", chatType: "gigagroup" },
        { type: "chat", chatType: "monoforum" },
        { type: "chat", chatType: "channel" },
        { type: "chat", chatType: "community" },
        { type: "chat", chatType: "some_future_type" },
      ].map(resolveSyncChatType),
    ).toEqual([
      "private",
      "group",
      "supergroup",
      "supergroup",
      "supergroup",
      "channel",
      "community",
      "group",
    ]);
  });
});

describe("signal handlers", () => {
  function addedSignalListeners(install: () => void) {
    const before = {
      SIGTERM: process.listeners("SIGTERM"),
      SIGINT: process.listeners("SIGINT"),
    };
    install();
    const added = {
      SIGTERM: process.listeners("SIGTERM").filter((l) => !before.SIGTERM.includes(l)),
      SIGINT: process.listeners("SIGINT").filter((l) => !before.SIGINT.includes(l)),
    };
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      for (const listener of added[signal]) process.off(signal, listener);
    }
    return added;
  }

  it("installs one SIGTERM handler, which sets the stop flag and aborts the stop signal", () => {
    const ctx = testDaemonContext();
    const added = addedSignalListeners(() => {
      setupSignalHandlers(ctx);
      setupSignalHandlers(ctx);
    });

    expect(added.SIGTERM).toHaveLength(1);
    added.SIGTERM[0]?.("SIGTERM");

    expect(ctx.logger.info).toHaveBeenCalledWith(
      "Received SIGTERM, initiating graceful shutdown...",
    );
    expect(ctx.state.shutdownRequested).toBe(true);
    expect(isDaemonStopError(ctx.runtime.shutdown.signal.reason)).toBe(true);
  });
});

describe("daemonNetworkMiddlewares", () => {
  function compose(
    middlewares: RpcCallMiddleware[],
    final: (ctx: RpcCallMiddlewareContext) => Promise<unknown>,
  ) {
    return middlewares.reduceRight<(ctx: RpcCallMiddlewareContext) => Promise<unknown>>(
      (next, middleware) => (ctx) => middleware(ctx, next),
      final,
    );
  }

  it("ends a FLOOD_WAIT the daemon's flood waiter sleeps out when the daemon stops", async () => {
    const ctx = testDaemonContext();
    const sent: string[] = [];
    const call = compose(daemonNetworkMiddlewares(ctx, 1), async (rpc) => {
      sent.push(rpc.request._);
      return {
        _: "mt_rpc_error",
        errorCode: 420,
        errorMessage: "FLOOD_WAIT_300",
      };
    });
    const manager = {
      teardownSignal: new AbortController().signal,
      _log: { warn: () => {} },
    } as unknown as RpcCallMiddlewareContext["manager"];
    setTimeout(() => requestShutdown(ctx), 20);

    const error = await call({
      request: { _: "messages.getHistory" } as unknown as tl.RpcMethod,
      manager,
      params: { abortSignal: ctx.runtime.shutdown.signal },
    }).catch((err: unknown) => err);

    expect(isDaemonStopError(error)).toBe(true);
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "[Account 1] messages.getHistory: FLOOD_WAIT, waiting 300s",
    );
    expect(sent).toEqual(["messages.getHistory"]);
  });

  describe("API activity", () => {
    const manager = {
      teardownSignal: new AbortController().signal,
      _log: { warn: () => {} },
    } as unknown as RpcCallMiddlewareContext["manager"];
    const rpc = (method: string) => ({
      request: { _: method } as unknown as tl.RpcMethod,
      manager,
    });

    function withCache() {
      const ctx = testDaemonContext();
      const db = createAccountCacheDb();
      ctx.runtime.accounts.set(1, { accountId: 1, db } as AccountRuntime);
      return { ctx, db };
    }

    it("logs Telegram's error code, and an error that isn't Telegram's without one", async () => {
      const { ctx, db } = withCache();
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async (req) => {
        if (req.request._ === "channels.getMessages") {
          return {
            _: "mt_rpc_error",
            errorCode: 400,
            errorMessage: "CHANNEL_PRIVATE",
          };
        }
        throw new Error("connection reset");
      });

      await call(rpc("channels.getMessages"));
      const thrown = await call(rpc("users.getUsers")).catch((err: unknown) => err);

      expect(thrown).toBeInstanceOf(Error);
      expect(
        db.query("SELECT method, success, error_code, context FROM api_activity ORDER BY id").all(),
      ).toEqual([
        {
          method: "channels.getMessages",
          success: 0,
          error_code: "400",
          context: "CHANNEL_PRIVATE",
        },
        {
          method: "users.getUsers",
          success: 0,
          error_code: null,
          context: "connection reset",
        },
      ]);
      db.close();
    });

    it("halves the account's sync pace on a FLOOD_WAIT of messages.getHistory only (#133)", async () => {
      const { ctx, db } = withCache();
      const rt = ctx.runtime.accounts.get(1)!;
      rt.pacer = createSyncPacer();
      rt.pacer.setHistoryDue(true);
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async () => ({
        _: "mt_rpc_error",
        errorCode: 420,
        errorMessage: "FLOOD_WAIT_400",
      }));
      const before = Date.now();

      await call(rpc("messages.getDialogs"));
      expect(rt.pacer.snapshot().floodWaits).toBe(0);
      await call(rpc("messages.getHistory"));

      expect(rt.pacer.snapshot()).toMatchObject({
        mode: "history",
        floodWaits: 1,
      });
      expect(rt.pacer.nextStartAt()).toBeGreaterThanOrEqual(before + 400_000);
      expect(ctx.logger.info).toHaveBeenCalledWith(
        "[Account 1] messages.getHistory: FLOOD_WAIT of 400s, history pace down to 0.35 calls/s",
      );
      db.close();
    });

    it("reads the seconds of FLOOD_WAIT and FLOOD_PREMIUM_WAIT only", () => {
      expect(floodWaitSecondsOf("FLOOD_WAIT_12")).toBe(12);
      expect(floodWaitSecondsOf("FLOOD_PREMIUM_WAIT_5")).toBe(5);
      expect(floodWaitSecondsOf("SLOWMODE_WAIT_5")).toBeNull();
      expect(floodWaitSecondsOf("CHANNEL_PRIVATE")).toBeNull();
    });

    it("sends the request without a log for an account without a cache, or a cache that fails", async () => {
      const ctx = testDaemonContext();
      const call = compose(daemonNetworkMiddlewares(ctx, 1), async () => ({
        _: "ok",
      }));
      expect(await call(rpc("users.getUsers"))).toEqual({ _: "ok" });

      const { ctx: closed, db } = withCache();
      db.close();
      const closedCall = compose(daemonNetworkMiddlewares(closed, 1), async () => ({ _: "ok" }));
      expect(await closedCall(rpc("users.getUsers"))).toEqual({ _: "ok" });
    });
  });
});
