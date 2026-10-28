# Full-Text Search (FTS5)

> **Status:** Implemented (2026-02-02) — current implementation in `src/db/sync-schema.ts`\n> and `src/db/messages-search.ts`.

## Schema

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  text,
  sender,
  chat,
  files,
  content='', contentless_delete=1,  -- SQLite 3.43 and newer
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS search_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```

### A contentless index

`message_search` keeps only the full-text index, not a copy of every message's text, sender
and chat: a contentless FTS5 table (`content=''`) stores the tokens and the rowid, and
`contentless_delete=1` lets the triggers below delete and replace rows on an edit or a delete.
Search never reads the table's columns: the query joins `messages_cache` by rowid and returns
the text from there, and nothing uses `snippet()`, `highlight()` or `bm25()`. So results are
the same as with the full-content table of 0.4 and older, column filters (`sender:alice`)
included, while the index takes about a third of the space (see
[database-schema.md](database-schema.md#capacity-planning-approx)). Selecting a column of
`message_search` itself (`tg sql`) returns `NULL`.

`contentless_delete` needs SQLite 3.43.0 or newer (`sqlite_version()`). On macOS Bun uses the
system libsqlite3, so this depends on the macOS version; on Linux and Windows Bun's bundled
SQLite is used ([build-distribution.md](build-distribution.md#notes)). With an older SQLite a
new cache gets the full-content table instead.

The first open of a cache with the full-content index, by this version on a new enough SQLite,
drops it and builds the contentless one from `messages_cache`, under the write lock like any
rebuild below (it waits up to a minute for the lock); `search_index_version` stays `1`. A 0.4
tg on the same SQLite reads the contentless table as up to date, so going back needs no
rebuild. The dropped index's pages stay in the file as free pages: run `tg db vacuum` once,
with the daemon stopped, to give them back to the disk and to switch the cache to incremental
auto_vacuum ([cli-commands.md](cli-commands.md#cache-maintenance)). Stop the daemon before
upgrading, so that the old daemon doesn't write while the new tg moves the index.

If an older SQLite opens a cache that has the contentless table (the same data directory used
from a newer macOS, say), it can't read that table: it drops only the three `messages_cache_a*`
triggers and sets `search_index_version` to `0`. Messages are still cached, and
`tg messages search` fails with SQLite's error (`GENERAL_ERROR`). The next open on a SQLite
with `contentless_delete` recreates the triggers and rebuilds the index, so search finds every
message again, those cached in between too.

### Indexed Columns

| Column | Purpose |
|--------|---------|
| `text` | Message text |
| `sender` | Username + name + user_id search blob |
| `chat` | Chat title + username + chat_id search blob (groups and channels too) |
| `files` | Media path (when available) |

## Triggered Indexing

The FTS index is kept in sync with `messages_cache` via triggers. An update re-indexes a
message only when its text, sender or media path changes: an edit, a sender fixed by a
migration. `UPDATE OF` alone fires whenever a column is in the `SET` list, and the upsert sets
every column, hence the `WHEN` clause. The rest leaves the index alone:

- A message fetched again unchanged (catch-up after a restart fetches again the messages that
  arrived live) is not written at all: the upsert updates the row only when a column other
  than `fetched_at` and `updated_at` differs, so both keep the time of the last real change.
- A changed `raw_json` alone (a channel post's views or reactions) rewrites the row but not
  its index row.
- Marking a message deleted sets `is_deleted` and keeps its index row; search filters on
  `is_deleted`.

The `sender` and `chat` columns copy names from `users_cache` and `chats_cache` when a message
is indexed. Up to 0.5.0 every re-fetch re-indexed the message and so refreshed them; now a
renamed user or chat shows its new name in the index only for messages indexed after the
rename, or whose text or sender changes. Results still show the current names, which search
reads from those tables. Re-indexing after a rename is tracked in
[#93](https://github.com/neoromantic/telegram-sync-cli/issues/93).

A cache created by 0.5.0 or older gets the new `messages_cache_au` on its first open by a newer
version ([database-schema.md](database-schema.md#migrations)).

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
AFTER UPDATE OF text, from_id, media_path ON messages_cache
WHEN old.text IS NOT new.text
  OR old.from_id IS NOT new.from_id
  OR old.media_path IS NOT new.media_path
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

If a column is missing, or the table is the full-content one where a contentless one is
supported, it drops and recreates `message_search` and its triggers;
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
