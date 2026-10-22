# Full-Text Search (FTS5)

> **Status:** Implemented (2026-02-02) — current implementation in `src/db/sync-schema.ts`\n> and `src/db/messages-search.ts`.

## Schema

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  text,
  sender,
  chat,
  files,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS search_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```

### Indexed Columns

| Column | Purpose |
|--------|---------|
| `text` | Message text |
| `sender` | Username + name + user_id search blob |
| `chat` | Chat title + username + chat_id search blob (groups and channels too) |
| `files` | Media path (when available) |

## Triggered Indexing

The FTS index is kept in sync with `messages_cache` via triggers.

```sql
CREATE TRIGGER IF NOT EXISTS messages_cache_ai
AFTER INSERT ON messages_cache
BEGIN
  INSERT INTO message_search(rowid, text, sender, chat, files)
  VALUES (
    new.rowid,
    COALESCE(new.text, ''),
    -- sender blob
    COALESCE(
      (SELECT trim(
        COALESCE(username, '') || ' ' ||
        COALESCE(first_name, '') || ' ' ||
        COALESCE(last_name, '') || ' ' ||
        COALESCE(display_name, '') || ' ' ||
        COALESCE(user_id, '')
      ) FROM users_cache WHERE user_id = CAST(new.from_id AS TEXT)),
      COALESCE(CAST(new.from_id AS TEXT), '')
    ),
    -- chat blob
    COALESCE(
      (SELECT trim(
        COALESCE(title, '') || ' ' ||
        COALESCE(username, '') || ' ' ||
        COALESCE(chat_id, '')
      ) FROM chats_cache WHERE chat_id = CAST(new.chat_id AS TEXT)),
      COALESCE(CAST(new.chat_id AS TEXT), '')
    ),
    COALESCE(new.media_path, '')
  );
END;

CREATE TRIGGER IF NOT EXISTS messages_cache_ad
AFTER DELETE ON messages_cache
BEGIN
  DELETE FROM message_search WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_cache_au
AFTER UPDATE ON messages_cache
BEGIN
  DELETE FROM message_search WHERE rowid = old.rowid;
  INSERT INTO message_search(rowid, text, sender, chat, files)
  VALUES (
    new.rowid,
    COALESCE(new.text, ''),
    COALESCE(
      (SELECT trim(
        COALESCE(username, '') || ' ' ||
        COALESCE(first_name, '') || ' ' ||
        COALESCE(last_name, '') || ' ' ||
        COALESCE(display_name, '') || ' ' ||
        COALESCE(user_id, '')
      ) FROM users_cache WHERE user_id = CAST(new.from_id AS TEXT)),
      COALESCE(CAST(new.from_id AS TEXT), '')
    ),
    COALESCE(
      (SELECT trim(
        COALESCE(title, '') || ' ' ||
        COALESCE(username, '') || ' ' ||
        COALESCE(chat_id, '')
      ) FROM chats_cache WHERE chat_id = CAST(new.chat_id AS TEXT)),
      COALESCE(CAST(new.chat_id AS TEXT), '')
    ),
    COALESCE(new.media_path, '')
  );
END;
```

## Index Versioning & Rebuild

A `search_index_version` key in `search_meta` tracks schema compatibility.
On startup, `initSyncSchema()` checks:

- The expected columns exist in `message_search`
- The stored version matches the current `SEARCH_INDEX_VERSION`

If a column is missing, it drops and recreates `message_search` and its triggers;
if either check fails, it rebuilds the index from `messages_cache`. That work runs
in one transaction under the write lock and checks again there, so when several
processes open the cache at once (the daemon and a command after the first login),
one builds the index while the others wait and then find nothing to do. An
up-to-date index is only read, so opening the cache doesn't wait for the lock.

The `chat` column reads the chat's `chats_cache` row, which has the same marked
peer ID as the message. Up to 0.2.0, `chats_cache` kept groups and channels under
bare IDs, so their messages were indexed without a title. The first open of such
a cache moves those rows to marked IDs and rebuilds the index once, so a query such
as `tg messages search --query "Team Chat"` finds the messages of that chat (see
[database-schema.md](database-schema.md#migrations)).

## Query Pattern

```sql
SELECT
  m.chat_id,
  m.message_id,
  m.from_id,
  m.text,
  m.message_type,
  m.has_media,
  m.media_path,
  m.is_outgoing,
  m.is_edited,
  m.is_pinned,
  m.is_deleted,
  m.reply_to_id,
  m.forward_from_id,
  m.edit_date,
  m.date,
  m.fetched_at,
  c.title as chat_title,
  c.username as chat_username,
  c.type as chat_type,
  u.username as sender_username,
  u.first_name as sender_first_name,
  u.last_name as sender_last_name
FROM message_search
JOIN messages_cache m ON m.rowid = message_search.rowid
LEFT JOIN chats_cache c ON c.chat_id = CAST(m.chat_id AS TEXT)
LEFT JOIN users_cache u ON u.user_id = CAST(m.from_id AS TEXT)
WHERE message_search MATCH ?
ORDER BY m.date DESC
LIMIT ? OFFSET ?;
```

## CLI Command

```bash
tg messages search --query "hello"
tg messages search --query "hello" --sender @alice
tg messages search --query "error OR timeout" --chat @teamchat

tg messages search \
  --query "hello" \
  --chat @teamchat \
  --sender @alice \
  --limit 50 \
  --offset 0 \
  --includeDeleted
```

### Supported Filters

- `--chat` (chat id or `@username`)
- `--sender` (user ID, `@username`, or the marked ID of a group or channel that posts as itself,
  such as `-1001234567890`)
- `--includeDeleted` (alias: `--include-deleted`)
- `--limit`, `--offset`

### FTS Query Tips

- Phrase: `"exact phrase"`
- Prefix: `hel*`
- Column filter: `sender:alice`, `chat:team`, `files:pdf`
- Boolean: `hello OR world`, `hello NOT world`

## Behavior Notes

- Search is cache-only. Results depend on what the daemon has synced.
- Deleted messages are excluded unless `--includeDeleted` (or `--include-deleted`) is set.
- Results are ordered by message date (descending).
- Read a hit in context with `tg messages get --chat <chatId> --id <messageId> --context 5`;
  `chatId` and `messageId` come from the result.

## Future Enhancements

- URL extraction and link search
- Topic/forum metadata for threaded chats
- Ranking (bm25) + highlights/snippets
- Media filename extraction
