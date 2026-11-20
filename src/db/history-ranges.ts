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
   * The page holds the newest messages below this ID, or it is a short page
   * capped by it
   */
  before?: number;
  /**
   * The chat's newest known message ID (knownTop), read before the request
   * was sent, for a page that holds the newest messages below `before` (the
   * chat's newest messages without it) or a short forward page. The page
   * then also vouches for the IDs above its newest message up to this one,
   * capped below `before`: Telegram gives a later message a higher ID than
   * any it had, so none can land there. Undefined for any other page
   */
  knownTop?: number | null;
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
  /**
   * The chat's newest known message ID: the highest of its cached messages,
   * the dialog list's top, the sync state's top and its recorded ranges;
   * 0 for a chat known to be empty, null when nothing is known
   */
  knownTop(chatId: number): number | null;
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
    knownTop: db.query(`
      SELECT MAX(
        COALESCE((SELECT MAX(message_id) FROM messages_cache WHERE chat_id = $chat_id), -1),
        COALESCE((SELECT last_message_id FROM chats_cache WHERE chat_id = $text_id), -1),
        COALESCE((SELECT top_message_id FROM chat_sync_state WHERE chat_id = $chat_id), -1),
        COALESCE((SELECT MAX(high) FROM history_ranges WHERE chat_id = $chat_id), -1)
      ) AS top
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

  const ranges: HistoryRanges = {
    add(chatId, { low, high }) {
      if (Number.isSafeInteger(low) && Number.isSafeInteger(high)) {
        if (low >= 1 && high >= (low === 1 ? 0 : low)) merge(chatId, low, high);
      }
    },

    recordPage(chatId, ids, { after, before, knownTop, reachedStart = false }) {
      const valid = ids.filter((id) => id > 0);
      let low = Math.min(...valid);
      if (after !== undefined) low = after + 1;
      else if (reachedStart) low = 1;

      let high = Math.max(...valid);
      if (knownTop !== undefined) {
        const top = knownTop ?? (before === undefined ? 0 : Number.NEGATIVE_INFINITY);
        high = Math.max(high, Math.min(top, (before ?? Number.POSITIVE_INFINITY) - 1));
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

    knownTop(chatId) {
      const { top } = stmts.knownTop.get({ $chat_id: chatId, $text_id: String(chatId) }) as {
        top: number;
      };
      return top < 0 ? null : top;
    },
  };

  return ranges;
}
