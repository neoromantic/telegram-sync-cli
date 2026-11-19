import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { fakeDialog } from "./fake-dialogs.test-utils";
import { dialogToCacheInput } from "../commands/chats/helpers";
import { createChatsCache } from "../db/chats-cache";
import { NO_CREDENTIALS, runCliFailure } from "./cli.test-utils";
import { createTestEnvironment, type TestEnvironment } from "./e2e-setup.test-utils";

const BARE_ID = "4242";
const CANDIDATES = [-4242, -1000000004242];

describe("E2E: a bare ID that names a cached group and a cached channel", () => {
  let env: TestEnvironment;

  beforeAll(() => {
    env = createTestEnvironment("ambiguous-ids");
    env.initDatabase();
    env.seedAccounts([{ phone: "+15550000000", user_id: 999, name: "Test", is_active: true }]);

    createChatsCache(env.openCacheDb(1)).upsertMany(
      [
        fakeDialog({ kind: "group", id: 4242, title: "Book Club" }),
        fakeDialog({ kind: "channel", id: 4242, title: "Example News" }),
      ].map(dialogToCacheInput),
    );
  });

  afterAll(() => {
    env.cleanup();
  });

  const message = `Ambiguous chat ID ${BARE_ID}: pass one of the marked IDs ${CANDIDATES.join(", ")}`;

  for (const [command, args, key] of [
    ["tg chats get", ["chats", "get", "--id", BARE_ID], "identifier"],
    ["tg chats sync", ["chats", "sync", BARE_ID], "chat"],
    ["tg messages list", ["messages", "list", "--chat", BARE_ID], "chat"],
  ] as const) {
    it(`${command} fails with INVALID_ARGS and both marked IDs`, async () => {
      const result = await runCliFailure([...args], 3, {
        env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
      });

      expect(result.json).toEqual({
        success: false,
        error: {
          code: "INVALID_ARGS",
          message,
          details: { [key]: BARE_ID, candidates: CANDIDATES },
          retryable: false,
        },
      });
    });
  }
});
