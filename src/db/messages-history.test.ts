import { expect, it } from "bun:test";

import { createMessagesCache } from "./messages-cache";
import { createMessagesHistory } from "./messages-history";
import { createAccountCacheDb } from "../test/cache-db.test-utils";

const CHAT_ID = 10;

it("anchors a window with both bounds at after", () => {
  const db = createAccountCacheDb();
  createMessagesCache(db).upsertBatch(
    Array.from({ length: 10 }, (_, i) => ({
      chat_id: CHAT_ID,
      message_id: i + 1,
      text: `team message ${i + 1}`,
      message_type: "text",
      date: 1_760_000_000 + i,
      raw_json: "{}",
    })),
  );
  const history = createMessagesHistory(db);
  const ids = (limit: number) =>
    history.list(CHAT_ID, { limit, after: 2, before: 7 }).map((row) => row.message_id);

  expect(ids(3)).toEqual([5, 4, 3]);
  expect(ids(10)).toEqual([6, 5, 4, 3]);
});
