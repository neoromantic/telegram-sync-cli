import type { Database } from "bun:sqlite";

import { MESSAGE_ROW_COLUMNS, MESSAGE_ROW_JOINS, type MessageSearchRow } from "./messages-search";

export interface NewMessagesOptions {
  /** Only this chat's messages (a marked peer ID) */
  chatId?: number;
  /** With `chatId`: the messages newer than this ID count, cached ones too */
  after?: number;
  /** Without `chatId`: only these chats' messages (allowedChats) */
  chatIds?: number[];
}

export interface NewMessagesFeed {
  /** With `after`: the chat's cached messages newer than it, oldest first */
  readonly initial: MessageSearchRow[];
  /**
   * The messages stored since the last poll that count as new, oldest
   * first. A message counts when it is newer than every message of its chat
   * the cache already had, so history the daemon backfills doesn't. Deleted
   * messages are left out.
   */
  poll(): MessageSearchRow[];
}

type FeedRow = MessageSearchRow & { row_id: number };

/** Oldest first: by date, then chat and message ID */
export function oldestFirst(a: MessageSearchRow, b: MessageSearchRow): number {
  return a.date - b.date || a.chat_id - b.chat_id || a.message_id - b.message_id;
}

export function createNewMessagesFeed(
  db: Database,
  { chatId, after, chatIds }: NewMessagesOptions = {},
): NewMessagesFeed {
  const chatFilter =
    chatId !== undefined
      ? "AND m.chat_id = $chat"
      : chatIds !== undefined
        ? "AND m.chat_id IN (SELECT value FROM json_each($chats))"
        : "";
  const dataVersion = db.query<{ data_version: number }, []>("PRAGMA data_version");
  const maxRowid = db.query<{ max: number | null }, []>(
    "SELECT MAX(rowid) AS max FROM messages_cache",
  );
  const storedRows = db.query<
    FeedRow,
    { $last: number; $max: number; $chat?: number; $chats?: string }
  >(`
    SELECT m.rowid AS row_id, ${MESSAGE_ROW_COLUMNS}
    FROM messages_cache m
    ${MESSAGE_ROW_JOINS}
    WHERE m.rowid > $last AND m.rowid <= $max ${chatFilter}
    ORDER BY m.rowid
  `);
  const newestBefore = db.query<{ message_id: number }, { $chat: number; $rowid: number }>(`
    SELECT message_id FROM messages_cache
    WHERE chat_id = $chat AND rowid <= $rowid
    ORDER BY message_id DESC
    LIMIT 1
  `);
  const cachedAfter = db.query<MessageSearchRow, { $chat: number; $after: number }>(`
    SELECT ${MESSAGE_ROW_COLUMNS}
    FROM messages_cache m
    ${MESSAGE_ROW_JOINS}
    WHERE m.chat_id = $chat AND m.message_id > $after AND m.is_deleted = 0
    ORDER BY m.message_id
  `);

  let lastVersion = dataVersion.get()?.data_version;
  const { startRowid, initial } = db.transaction(() => ({
    startRowid: maxRowid.get()?.max ?? 0,
    initial:
      chatId !== undefined && after !== undefined
        ? cachedAfter.all({ $chat: chatId, $after: after })
        : [],
  }))();

  let lastRowid = startRowid;
  const newest = new Map<number, number>();
  const newestOf = (chat: number) => {
    let id = newest.get(chat);
    if (id === undefined) {
      id = newestBefore.get({ $chat: chat, $rowid: startRowid })?.message_id ?? 0;
      if (chat === chatId && after !== undefined) id = Math.max(id, after);
      newest.set(chat, id);
    }
    return id;
  };

  return {
    initial,
    poll() {
      const version = dataVersion.get()?.data_version;
      if (version === lastVersion) return [];
      lastVersion = version;

      const rows = db.transaction(() => {
        const max = maxRowid.get()?.max ?? 0;
        if (max <= lastRowid) return [];
        const stored = storedRows.all({
          $last: lastRowid,
          $max: max,
          ...(chatId !== undefined && { $chat: chatId }),
          ...(chatId === undefined && chatIds !== undefined && { $chats: JSON.stringify(chatIds) }),
        });
        lastRowid = max;
        return stored;
      })();

      const fresh: MessageSearchRow[] = [];
      for (const { row_id: _rowid, ...row } of rows) {
        const before = newestOf(row.chat_id);
        if (row.message_id <= before) continue;
        newest.set(row.chat_id, row.message_id);
        if (row.is_deleted === 0) fresh.push(row);
      }
      return fresh.sort(oldestFirst);
    },
  };
}
