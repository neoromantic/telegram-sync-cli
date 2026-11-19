import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { MemoryStorage, TelegramClient } from "@mtcute/bun";
import {
  accountLabel,
  createLogger,
  formatClientLog,
  maskPhone,
  routeClientLogs,
} from "./daemon-logger";
import type { DaemonVerbosity } from "./types";
import { watchedLogger } from "../test/daemon-runtime.test-utils";

function watchConsole() {
  return {
    log: spyOn(console, "log"),
    warn: spyOn(console, "warn"),
    error: spyOn(console, "error"),
  };
}

afterEach(() => {
  mock.restore();
});

describe("createLogger", () => {
  it("prints warnings and errors always, info unless quiet, debug only when verbose", () => {
    const { log, warn, error } = watchConsole();
    const printed = (verbosity: DaemonVerbosity) => {
      for (const spy of [log, warn, error]) spy.mockClear();
      const logger = createLogger(verbosity);
      logger.info("info");
      logger.debug("debug");
      logger.warn("warn");
      logger.error("error");
      return [log, warn, error].flatMap((spy) =>
        spy.mock.calls.map(([line]) => String(line).replace(/^\[[^\]]+\] /, "")),
      );
    };

    expect(printed("quiet")).toEqual(["[WARN] warn", "[ERROR] error"]);
    expect(printed("normal")).toEqual(["[INFO] info", "[WARN] warn", "[ERROR] error"]);
    expect(printed("verbose")).toEqual([
      "[INFO] info",
      "[DEBUG] debug",
      "[WARN] warn",
      "[ERROR] error",
    ]);
  });
});

describe("account labels (#128)", () => {
  it("masks a short phone whole and names an account without a phone by its ID", () => {
    expect(maskPhone("123")).toBe("***");
    expect(accountLabel({ accountId: 3, phone: "user:42" })).toBe("#3");
  });
});

describe("routeClientLogs (#128)", () => {
  function fakeClient() {
    const errorHandlers: Array<(err: Error) => void> = [];
    const mgr = {
      level: 5,
      handler: (_color: number, _level: number, _tag: string, _fmt: string, _args: unknown[]) => {},
    };
    const client = {
      log: { mgr },
      onError: { add: (fn: (err: Error) => void) => errorHandlers.push(fn) },
    } as unknown as TelegramClient;
    return { client, mgr, errorHandlers };
  }

  it("keeps mtcute's warnings for --verbose and its update gap chatter at debug", () => {
    const quiet = fakeClient();
    routeClientLogs(quiet.client, watchedLogger(), "normal", "[Account 1]");
    expect(quiet.mgr.level).toBe(1);

    const { client, mgr } = fakeClient();
    const log = watchedLogger();
    routeClientLogs(client, log, "verbose", "[Account 1]");
    expect(mgr.level).toBe(2);

    mgr.handler(
      0,
      2,
      "updates",
      "[USER 42] pts_before does not match local_pts for %s (cid = %d)",
      ["updateNewChannelMessage", Number.NaN],
    );
    mgr.handler(0, 2, "mtproto", "ping timed out", []);
    const err = new Error("boom");
    err.stack = "Error: boom\n    at source dump";
    mgr.handler(0, 1, "client", "unhandled error:", [err]);

    expect(log.debug.mock.calls).toEqual([
      [
        "[Account 1] [mtcute updates] pts_before does not match local_pts for updateNewChannelMessage (cid = NaN)",
      ],
    ]);
    expect(log.warn.mock.calls).toEqual([["[Account 1] [mtcute mtproto] ping timed out"]]);
    expect(log.error.mock.calls).toEqual([["[Account 1] [mtcute client] unhandled error: boom"]]);
  });

  it("logs a client error in one line, and the same error again only at debug for 5 minutes", () => {
    const { client, errorHandlers } = fakeClient();
    const log = watchedLogger();
    let now = 0;
    routeClientLogs(client, log, "normal", "[Account 1]", () => now);
    const err = new Error("Could not connect to DC 2\nusing any address");
    err.stack = `${err.message}\n    at minified source`;

    errorHandlers[0]!(err);
    now = 60_000;
    errorHandlers[0]!(err);
    now = 6 * 60_000;
    errorHandlers[0]!(err);

    const line = "[Account 1] Telegram client error: Could not connect to DC 2 using any address";
    expect(log.warn.mock.calls).toEqual([[line], [line]]);
    expect(log.debug.mock.calls).toEqual([[line]]);
  });
});

describe("formatClientLog", () => {
  it("fills in the format and appends extra arguments, objects by type", () => {
    expect(formatClientLog("%s took %d ms", ["ping", 12, { _: "pong" }, { a: 1 }])).toBe(
      "ping took 12 ms <pong> <object>",
    );
  });
});

describe("routeClientLogs with mtcute's own logger (#128)", () => {
  it("keeps payloads that may hold phones, names or message text and stacks out of the log", async () => {
    const client = new TelegramClient({
      apiId: 1,
      apiHash: "example",
      storage: new MemoryStorage(),
    });
    const log = watchedLogger();
    try {
      routeClientLogs(client, log, "verbose", "[Account 1]");

      client.log.create("session").warn("received rpc_result for unknown message %l: %j", 123, {
        _: "messages.dialogs",
        users: [
          {
            _: "user",
            id: 42,
            phone: "15550000001",
            firstName: "Example",
            lastName: "User",
          },
        ],
        messages: [{ _: "message", id: 1, message: "Example text" }],
      });
      const err = new Error("Example transport failure");
      err.stack = `Error: Example transport failure\n    at privateSource (/$bunfs/root/tg:1:2)`;
      client.log.create("client").error("Authorization error: %e", err);
      client.log.create("session").warn("raw %j then %s", [{ a: 1 }], "more");
    } finally {
      await client.destroy();
    }

    expect(log.warn.mock.calls).toEqual([
      [
        "[Account 1] [mtcute session] received rpc_result for unknown message 123: <messages.dialogs>",
      ],
      ["[Account 1] [mtcute session] raw <payload> more"],
    ]);
    expect(log.error.mock.calls).toEqual([
      ["[Account 1] [mtcute client] Authorization error: Error: Example transport failure"],
    ]);
  });
});
