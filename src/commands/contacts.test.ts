import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

import { createUsersCache } from "../db/users-cache";
import { createAccountCacheDb } from "../test/cache-db.test-utils";
import { mockDbModule } from "../test/db-mock.test-utils";

const createMockClient = () => ({
  call: mock(() => Promise.resolve({})),
  getMe: mock(() => Promise.resolve({ id: 123, firstName: "Test" })),
});

let mockClient = createMockClient();
mock.module("../services/telegram", () => ({
  getClientForAccount: mock(() => mockClient),
}));

let testCacheDb: Database;
mock.module("../db", () => mockDbModule({ cacheFor: () => testCacheDb }));

describe("contacts list --fresh", () => {
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    testCacheDb = createAccountCacheDb();
    logSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    testCacheDb.close();
  });

  it("fetches the full list and unmarks a contact removed on Telegram", async () => {
    const usersCache = createUsersCache(testCacheDb);
    for (const id of ["1001", "1002"]) {
      usersCache.upsert({
        user_id: id,
        first_name: `Cached ${id}`,
        is_contact: 1,
        fetched_at: 1000,
        raw_json: JSON.stringify({ _: "user", id: Number(id), contact: true }),
      });
    }
    const call = mock(async (_request: { _: string; hash: unknown }) => ({
      _: "contacts.contacts",
      contacts: [{ _: "contact", userId: 1001, mutual: false }],
      savedCount: 1,
      users: [{ _: "user", id: 1001, firstName: "Alice", contact: true }],
    }));
    mockClient = {
      ...createMockClient(),
      call,
    } as unknown as typeof mockClient;

    const { listContactsCommand } = await import("./contacts");
    const run = listContactsCommand.run as (input: {
      args: Record<string, unknown>;
    }) => Promise<void>;
    await run({ args: { fresh: true, limit: "50", offset: "0" } });

    expect(call).toHaveBeenCalledTimes(1);
    const request = call.mock.calls[0]?.[0];
    expect(request?._).toBe("contacts.getContacts");
    expect(String(request?.hash)).toBe("0");

    const output = JSON.parse(logSpy.mock.calls[0]?.[0] as string);
    expect(output.success).toBe(true);
    expect(output.data).toMatchObject({
      source: "api",
      total: 1,
      hasMore: false,
      items: [{ id: 1001, firstName: "Alice" }],
    });

    expect(usersCache.getById("1001")?.is_contact).toBe(1);
    const removed = usersCache.getById("1002");
    expect(removed?.is_contact).toBe(0);
    expect(removed?.fetched_at).toBe(1000);
  });
});
