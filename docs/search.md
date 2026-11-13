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
the text from there. `bm25()` and `rank` work on a contentless table; `snippet()` and
`highlight()` don't, so `--snippet` is computed in tg. So results are
the same as with the full-content table of 0.4 and older, column filters (`sender:alice`)
included, while the index takes about a third of the space (see
[database-schema.md](database-schema.md#capacity-planning)). Selecting a column of
`message_search` itself (`tg sql`) returns `NULL`; query the view
[`message_search_text`](#sql-the-message_search_text-view) for the text instead.

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
from a newer macOS, say), it can't read that table: it drops only the triggers that write it (the three
`messages_cache_a*` and those that fill `search_reindex_queue`) and sets
`search_index_version` to `0`. Messages are still cached, and
`tg messages search` fails with SQLite's error (`GENERAL_ERROR`). The next open on a SQLite
with `contentless_delete` recreates the triggers and rebuilds the index, so search finds every
message again, those cached in between too.

### Indexed Columns

| Column | Purpose |
|--------|---------|
| `text` | Message text |
| `sender` | Username + name + user_id search blob; a channel or group that posts as itself: its title + username + chat_id |
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

### Names after a rename

The `sender` and `chat` columns copy names from `users_cache` and `chats_cache` when a message
is indexed. Results always show the current names, which search reads from those tables; the
index catches up in the background (#93):

- When a `users_cache` row is inserted, or its username, first, last or display name changes,
  triggers queue a re-index of that sender's messages in `search_reindex_queue`. A
  `chats_cache` row does the same for its chat's messages when it is inserted or its title or
  username changes. So a rename, and a sender or chat cached after their messages (before 0.9.0
  the daemon didn't cache the senders of history pages, #126), both reach the index.
- A channel or group that posts as itself has its marked ID as `from_id`: `sender:` matches its
  title and username from `chats_cache`, and its insert or rename also queues the messages it
  posted, in any chat.
- An upsert that changes none of those names (every dialog pass rewrites thousands of rows)
  queues nothing, and neither does a peer with no cached messages.
- Only the messages cached so far are queued: those written later read the new names already.
  A peer renamed again before its re-index ends starts over.
- The daemon drains the queue after its sync work, a few batches per tick, each its own short
  write transaction, like the [background migrations](database-schema.md#background-migrations):
  at most 500 messages (2,500 for `tg db migrate` next to the daemon), and none started after
  50 ms. Without the daemon, `tg db migrate` drains it. Until then a
  search by the new name misses the older messages, and one by the old name still finds them.
- On an older SQLite that disables search (see [above](#a-contentless-index)), the queue and the
  one-off re-index below wait; the next open on a newer SQLite rebuilds the index with the
  current names, which empties the queue.
- A sender with no `users_cache` row at all stays indexed under its numeric ID: tg doesn't ask
  Telegram for it.
- Caches written before this queue existed get a one-off re-index of every message, the
  background migration `message_search_names` (shown by `tg status`, finished by
  `tg db migrate`). `tg db migrate` does 1M messages in about 27 s; the daemon, at 250 ms a
  second, should take about 2 minutes ([storage.md](storage.md#6-big-caches)).

A re-index deletes rows of the index and inserts them again, and FTS5 handles that its own way:

- It merges a segment of the index once 10% of its rows are deleted (its `deletemerge` option),
  inside the insert that flushes the index to disk. tg sets `deletemerge` to 0 on every cache:
  deleted rows leave the index when their segments merge as it grows, as FTS5 merges them
  anyway. Until then the index is larger: right after the one-off re-index of the made-up
  caches of [storage.md](storage.md), 19.7 MB instead of 11.8 MB at 100,000 messages and
  106 MB instead of 104 MB at 1M.
- It writes its pending rows to disk as a new segment at every statement savepoint, and SQLite
  opens one for an `INSERT … SELECT`, which may write many rows, but not for an
  `INSERT … VALUES` of one row. So the re-index reads the names first and inserts plain values:
  a batch writes one segment, not one per message, which halved the time of the re-index.

On 100,000 made-up messages of one sender, every word repeated in each, the re-index of that
sender took 9.1 s with batches of up to 0.55 s before; it takes 1.0 s, with batches of 41 ms at
most. On the 1M cache of storage.md the one-off re-index went from 70 s to 27–36 s; 14 of its
2,070 batches took more than 100 ms (up to 179 ms), and one run had a batch of 1.04 s. Those
are FTS5 merging its big segments a common word at a time, which no batch size splits.
History writes hit the same: writing that cache in pages of 100 messages, 4 of the 10,050
pages took more than 100 ms (up to 253 ms), and right after the re-index the merges it left
made 16 of the next 100 pages take 104–212 ms (up to 0.73 s in another run), then none of the
2,900 after them.

## Index Versioning & Rebuild

A `search_index_version` key in `search_meta` tracks schema compatibility.
On startup, `initSyncSchema()` checks:

- The expected columns exist in `message_search`
- The stored version matches the current `SEARCH_INDEX_VERSION`

If a column is missing, or the table is the full-content one where a contentless one is
supported, it drops and recreates `message_search` and its triggers;
if either check fails, it rebuilds the index from `messages_cache` (with the names cached now,
so it empties `search_reindex_queue`). That work runs
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
ORDER BY m.date DESC, m.rowid
LIMIT ? OFFSET ?;
```

Messages sent in the same second go in rowid order, the order they were cached, so the pages
of `--offset` never overlap.

This query reads every match and its message before it sorts them: a word in 30% of 10M
messages took seconds. So when a query has many matches, the newest page comes another way
([#118](https://github.com/neoromantic/telegram-sync-cli/issues/118)), with the same rows in the
same order. For a page of P (`--limit` plus `--offset`) of N messages:

- **Counting.** tg counts the matches in the index, up to T = √(900 × P × N): 212,000 for a
  page of 50 at 1M messages, 671,000 at 10M. With fewer than T, it sorts them as the query
  above does; for a phrase or several words, from the rowids it has just read, without asking
  the index again.
- **Walking.** With T or more, tg goes through the newest messages, from `--until` back, by
  `idx_messages_cache_newest` (`messages_cache(date DESC)`, or `idx_messages_cache_date` with
  `--chat`), and asks the index of each whether it matches, until the page is full. It goes
  through at most P × N / T messages (236 for a page of 50 at 1M), as many as a page needs when
  T of N messages match. That index gives them newest first and, within a second, in rowid
  order, so a page found there is the right one even when it ends inside a second. When a
  filter such as `--sender` leaves too few matches there, or the matches are older, tg runs the
  query above.
- **A prefix** (`word*`) always uses the query above: asking about one message would read every
  word the prefix starts.

Asking the index about one message costs as much as sorting tens to hundreds of matches of the
query above, so the walk pays only when matches are many. When it finds too few, counting and
walking add at most about 30% to the query above: on made-up caches, a word only in the oldest
messages took 55 ms instead of 43 ms at 1M messages and 98 ms instead of 82 ms at 10M.

`--sort relevance` and `--count` still read every match.

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

### Query Rules

A query without FTS5 syntax is a list of words: a message matches when it contains every word,
in any order. Each word is quoted before it goes to FTS5, so punctuation inside a word
(`don't`, `e-mail`, `че-нить`) is never read as syntax.

A query with FTS5 syntax goes to FTS5 as written. FTS5 syntax is any of `"`, `*`, `:`, `(`,
`)`, `^` at the start of a word, `+` standing between phrases, or one of the words `AND`, `OR`,
`NOT`, `NEAR` in capitals. Lowercase `and` is a plain word, and so are `C++` and `2^10`: a `+`
or `^` inside a word is punctuation:

| Query | Finds |
|-------|-------|
| `hello world` | messages with both words, anywhere |
| `"hello world"` | the exact phrase |
| `error OR timeout` | either word |
| `hello NOT club` | `hello` without `club` in the text, sender or chat |
| `sender:alice` | messages whose sender's username, name or ID contains `alice` |
| `chat:team` | messages in chats whose title, username or ID contains `team` |
| `hel*` | words that start with `hel` |
| `квартир*` | every form of a word: `квартира`, `квартиру`, `квартирой` |
| `^hello` | messages whose text starts with `hello` |

FTS5 doesn't stem words, so a prefix (`word*`) is the way to find other forms of a word, in
Russian especially. Matching ignores case, and diacritics in Latin letters (`cafe` finds
`café`); `ё` and `й` stay distinct from `е` and `и`.

`--phrase` matches the whole query as one exact phrase, the way `tg messages search` read
every query up to 0.5: `--query "function(arg)" --phrase` finds the text without reading the
parentheses as syntax.

A query FTS5 can't parse, such as `error OR` or `meet at 10:30` (`10:` reads as a column
name), returns `INVALID_ARGS` (exit 3) with a suggestion: quote the words with punctuation
(`meet at "10:30"`) or pass `--phrase`. Other SQLite errors return `GENERAL_ERROR`.

### Supported Filters

- `--chat` (chat id or `@username`)
- `--sender` (user ID, `@username`, or the marked ID of a group or channel that posts as itself,
  such as `-1001234567890`)
- `--includeDeleted` (alias: `--include-deleted`)
- `--phrase`: the whole query as one phrase
- `--since`, `--until`: the date range, on the date a message was sent (see below)
- `--sort date|relevance`: `date` (default) is newest first; `relevance` is best match first,
  by FTS5's bm25 rank over the text, sender and chat, with ties newest first
- `--count`: also count every message that matches the query and the filters, in `count`
- `--snippet`: add a highlighted fragment of the text to each result ([Snippets](#snippets))
- `--limit`, `--offset`

`--since` keeps messages sent at or after its time, `--until` those sent before it. Each takes:

| Value | Means |
|-------|-------|
| `30m`, `24h`, `7d`, `2w` | that long before now |
| `2026-10-01` | local midnight that day; for `--until`, the midnight after it, so the day counts |
| `2026-10-01T09:30` | local time; add `Z` or an offset (`2026-10-01T09:30+03:00`) for another zone |

A value in another form, or `--since` that isn't earlier than `--until`, is `INVALID_ARGS`.

```bash
tg messages search --query "invoice" --since 7d
tg messages search --query "deploy" --since 2026-10-01 --until 2026-10-07 --sort relevance
tg messages search --query "hello world" --limit 10 --count
```

### Output

```json
{
  "query": "hello world",
  "filters": { "chat": null, "sender": null, "includeDeleted": false, "phrase": false,
               "since": "7d", "until": null },
  "sort": "date",
  "results": [ … ],
  "total": 10,
  "count": 42,
  "limit": 10,
  "offset": 0,
  "source": "cache",
  "stale": false
}
```

`total` is the number of results on this page, at most `--limit`. `count` is the number of
messages that match with the same filters, over every page, and is `null` without `--count`: it
is a second query, so it is opt-in. Page with `--offset` until `results` is empty, or until
`offset + total` reaches `count`.

The `files` column is empty for now: attachment names are in `message_attachments` and in
each item's `attachment`, but not in the index yet
([#94](https://github.com/neoromantic/telegram-sync-cli/issues/94)), so `files:` finds nothing.

### Snippets

`--snippet` adds `snippet` to each result: the message text around the first word the query
matched, about ten words on each side, `…` where the text is cut, and every matched word in
`**`. The markers are plain characters: `--format pretty` prints them as they are, and a
Markdown viewer shows the words in bold. A text with long words or no spaces (a run of emoji)
is cut to at most 300 characters around the match, never inside an emoji:

```json
{ "messageId": 1200, "text": "…", "snippet": "…after the release the **deploy** failed twice, so we rolled back and…" }
```

The words come from the query's free text: column filters other than `text` (`sender:`,
`chat:`) and `NOT` terms are left out. They match the way the index does: case-insensitively,
a Latin letter with one diacritic read as the bare letter (`cafe` finds `café`, `o` doesn't find
`ộ`), and a prefix (`hel*`) matches every word that starts with it, in Latin
and Cyrillic. A message the query found only by its sender or chat gets the start of its text,
nothing highlighted; a message without text gets `""`. FTS5's `snippet()` can't run on the
contentless index, so tg builds the fragment from `messages_cache.text`.

## SQL: the `message_search_text` view

`message_search_text` joins the index with `messages_cache`, the chat and the sender, so
`tg sql` gets matches with their text without writing the join. It stores nothing. Its column
named like the view is the index itself: filter with `MATCH` (the same FTS5 syntax as
`--query`, without the plain-word quoting) and order with `rank` (bm25, lower is better).
SQLite flattens the view and gives the `MATCH` to FTS5, so the query reads only the matches:

```sql
SELECT chat_title, sender_username, message_id, date, text
FROM message_search_text
WHERE message_search_text MATCH 'deploy OR release'
  AND is_deleted = 0
  AND date >= unixepoch('now', '-7 days')   -- date is in Unix seconds
ORDER BY rank
LIMIT 20;
```

The other columns are `rank`, `rowid` and the columns of a search row (`chat_id`,
`message_id`, `from_id`, `text`, `message_type`, `has_media`, `media_path`, `is_outgoing`,
`is_edited`, `is_pinned`, `is_deleted`, `reply_to_id`, `forward_from_id`, `edit_date`, `date`,
`fetched_at`, `chat_title`, `chat_username`, `chat_type`, `sender_username`,
`sender_first_name`, `sender_last_name`). `snippet()` and `highlight()` don't work on it; use
`tg messages search --snippet`. The view is created after the index and outlives a rebuild that
drops and recreates `message_search`. `tg sql print-schema --table=message_search_text`
describes each column.

## Behavior Notes

- Search is cache-only. Results depend on what the daemon has synced.
- Deleted messages are excluded unless `--includeDeleted` (or `--include-deleted`) is set.
- Results are ordered by message date (descending), or by relevance with `--sort relevance`;
  messages sent in the same second go in the order they were cached.
- Read a hit in context with `tg messages get --chat <chatId> --id <messageId> --context 5`;
  `chatId` and `messageId` come from the result.

## Future Enhancements

- URL extraction and link search
- Topic/forum metadata for threaded chats
- Attachment file names in the `files` column, so `files:pdf` finds documents
