import type { Database } from "bun:sqlite";
import { describe, expect, it, mock, spyOn } from "bun:test";
import type { tl } from "@mtcute/bun";

import { getAccountCacheDb } from "../db";
import { createUsersCache } from "../db/users-cache";
import { toLong } from "../utils/long";
import { testAccount, useTestDataDir } from "../test/accounts.test-utils";

const firstClient = { call: mock(async (_request: { _: string }) => ({})) };
let secondClient: unknown = null;

const getClientForAccount = mock((accountId: number) =>
  accountId === 2 ? secondClient : firstClient,
);
mock.module("../services/telegram", () => ({ getClientForAccount }));

useTestDataDir([testAccount(), testAccount({ phone: "+15550000002", is_active: false })]);

describe("userCommand with two accounts", () => {
  const BOB: tl.RawUser = {
    _: "user",
    id: 202,
    accessHash: toLong("222"),
    firstName: "Bob",
    lastName: "Baker",
    username: "bob_example",
    phone: "15550000202",
  };

  it("fetches with --fresh on the selected account's client and caches the user there", async () => {
    const firstCacheDb = getAccountCacheDb(1);
    const secondCacheDb = getAccountCacheDb(2);
    createUsersCache(secondCacheDb).upsert({
      user_id: "202",
      first_name: "Old",
      fetched_at: Date.now(),
      raw_json: "{}",
    });
    const call = mock(async (request: { _: string }) => {
      if (request._ !== "users.getUsers") {
        throw new Error(`Unexpected API call ${request._}`);
      }
      return [BOB];
    });
    secondClient = { call };
    const { userCommand } = await import("./user/lookup");
    const run = userCommand.run as (input: { args: Record<string, unknown> }) => Promise<void>;
    const logSpy = spyOn(console, "log");

    try {
      await run({
        args: { identifier: "202", account: "2", fresh: true, _: [] },
      });
    } finally {
      logSpy.mockRestore();
    }

    expect(getClientForAccount.mock.calls).toEqual([[2]]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(firstClient.call).not.toHaveBeenCalled();
    expect(createUsersCache(secondCacheDb).getById("202")).toMatchObject({
      first_name: "Bob",
      access_hash: "222",
    });
    expect(createUsersCache(firstCacheDb).getById("202")).toBeNull();
    const activity = (db: Database) => db.query("SELECT method FROM api_activity").all();
    expect(activity(secondCacheDb)).toEqual([{ method: "users.getUsers" }]);
    expect(activity(firstCacheDb)).toEqual([]);
  });
});
