import type { Database } from "bun:sqlite";

export interface HistoryRange {
  low: number;
  high: number;
}

/** What a getHistory page says beyond the IDs of the messages it returned */
export interface PageBounds {
  /** The page holds the oldest messages above this ID */
  after?: number;
  /**
   * Nothing lies between the page's newest message and this ID: the page
   * holds the newest messages below it, or it is a short page capped by it
   */
  before?: number;
  /** The page ran out of older messages, so it reaches the first message */
  reachedStart?: boolean;
}

export interface HistoryRanges {
  /** Record a range, merged with the ranges it touches or overlaps */
  add(chatId: number, range: HistoryRange): void;
  /**
   * Record the range a cached getHistory page covers. `ids` are the IDs of
   * every message it returned, empty ones included. Call it after the page's
   * messages are stored.
   */
  recordPage(chatId: number, ids: number[], bounds: PageBounds): void;
  /** The recorded range that holds this message ID */
  find(chatId: number, messageId: number): HistoryRange | null;
  /** The newest recorded range that ends below this message ID */
  below(chatId: number, messageId: number): HistoryRange | null;
}

export function createHistoryRanges(db: Database) {
  const stmts = {
    find: db.query(`
      SELECT low, high FROM history_ranges
      WHERE chat_id = $chat_id AND low <= $id AND high >= $id
      LIMIT 1
    `),
    below: db.query(`
      SELECT low, high FROM history_ranges
      WHERE chat_id = $chat_id AND high < $id
      ORDER BY high DESC
      LIMIT 1
    `),
    touching: db.query(`
      SELECT MIN(low) AS low, MAX(high) AS high FROM history_ranges
      WHERE chat_id = $chat_id AND low <= $high + 1 AND high >= $low - 1
    `),
    deleteTouching: db.prepare(`
      DELETE FROM history_ranges
      WHERE chat_id = $chat_id AND low <= $high + 1 AND high >= $low - 1
    `),
    insert: db.prepare(`
      INSERT INTO history_ranges (chat_id, low, high, updated_at)
      VALUES ($chat_id, $low, $high, $now)
    `),
    hasMessageFrom: db.query(`
      SELECT 1 FROM messages_cache
      WHERE chat_id = $chat_id AND message_id >= $id
      LIMIT 1
    `),
  };

  const merge = db.transaction((chatId: number, low: number, high: number) => {
    const params = { $chat_id: chatId, $low: low, $high: high };
    const touching = stmts.touching.get(params) as {
      low: number | null;
      high: number | null;
    };
    stmts.deleteTouching.run(params);
    stmts.insert.run({
      $chat_id: chatId,
      $low: Math.min(low, touching.low ?? low),
      $high: Math.max(high, touching.high ?? high),
      $now: Date.now(),
    });
  });

  const hasMessageFrom = (chatId: number, id: number) =>
    stmts.hasMessageFrom.get({ $chat_id: chatId, $id: id }) !== null;

  const ranges: HistoryRanges = {
    add(chatId, { low, high }) {
      if (Number.isSafeInteger(low) && Number.isSafeInteger(high)) {
        if (low >= 1 && high >= low) merge(chatId, low, high);
      }
    },

    recordPage(chatId, ids, { after, before, reachedStart = false }) {
      const valid = ids.filter((id) => id > 0);
      let low = Math.min(...valid);
      if (after !== undefined) low = after + 1;
      else if (reachedStart) low = 1;

      let high = Math.max(...valid);
      if (before !== undefined && hasMessageFrom(chatId, before)) {
        high = before - 1;
      }

      ranges.add(chatId, { low, high });
    },

    find(chatId, messageId) {
      return (
        (stmts.find.get({
          $chat_id: chatId,
          $id: messageId,
        }) as HistoryRange | null) ?? null
      );
    },

    below(chatId, messageId) {
      return (
        (stmts.below.get({
          $chat_id: chatId,
          $id: messageId,
        }) as HistoryRange | null) ?? null
      );
    },
  };

  return ranges;
}
