import { beforeEach, describe, expect, it } from "bun:test";

import { collectStatus } from "./status";
import { createPidFile } from "../daemon";
import { getAccountCacheDb } from "../db";
import { createMessagesCache } from "../db/messages-cache";
import { testAccount, useTestDataDir } from "../test/accounts.test-utils";

const noDaemon = createPidFile("/nonexistent/daemon.pid");

useTestDataDir([testAccount(), testAccount({ phone: "+15550000002", is_active: false })]);

beforeEach(() => {
  for (const accountId of [1, 2]) {
    const cache = getAccountCacheDb(accountId);
    createMessagesCache(cache).upsertBatch([
      {
        chat_id: 101,
        message_id: accountId,
        text: `note ${accountId}`,
        message_type: "text",
        date: 1_760_000_000,
        raw_json: "{}",
      },
    ]);
  }
  getAccountCacheDb(1).run("DROP TABLE messages_cache");
});

describe("tg status with a cache that fails a query", () => {
  it("reports the error with zeroed figures and still reports the other account's", async () => {
    const status = await collectStatus(noDaemon, { dataDir: "/nonexistent" });

    expect(status.accounts.accounts.map((a) => [a.id, a.cache])).toEqual([
      [1, { status: "error", error: expect.stringContaining("messages_cache"), size: null }],
      [2, expect.objectContaining({ status: "ok" })],
    ]);
    expect(status.accounts.accounts[1]?.progress.messages_cached).toBe(1);
    expect(status.progress.messages_cached).toBe(1);
    expect(status.daemon.status).toBe("stopped");
  });
});
