# Database Schema

## Overview

This document defines the current on-disk schema used by telegram-sync-cli. It follows these principles:

> **Tip:** Use `tg sql print-schema --output=sql` to get the live schema with annotated comments explaining each column and its semantic type.

1. **Local-first** — all data is stored locally via SQLite
2. **raw_json for future-proofing** — cached entities keep the original TL object
3. **Stale-while-revalidate** — cached data is returned immediately, refreshed on demand

## File Structure

Default data directory: `~/.telegram-sync-cli` (override with `TELEGRAM_SYNC_CLI_DATA_DIR`).

```
~/.telegram-sync-cli/
├── data.db              # Accounts table, nothing else
├── session_<id>.db      # mtcute session per account
├── accounts/<id>/       # One directory per account (mode 0700)
│   └── cache.db         # The account's cache, sync state, jobs and rate limits
├── shared-cache.db      # Only after an upgrade with several accounts (see Migrations)
├── daemon.pid           # PID file when daemon is running
└── config.json          # User config (cache TTLs, active account)
```

`<id>` is `accounts.id` in `data.db`, the ID `tg accounts list` prints. Every account has its
own `cache.db` with the same tables and no account column: the file is the account. IDs are
unique only within one account's cache; a message ID or a basic group ID can mean something
else in another account's file. A command creates the file on first use; `tg status` and
`tg sql print-schema` never create one.

---

## data.db Schema (Accounts)

```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  user_id INTEGER,
  name TEXT,
  username TEXT,
  label TEXT,
  session_data TEXT NOT NULL DEFAULT '',
  is_active INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_accounts_phone ON accounts(phone);
CREATE UNIQUE INDEX idx_accounts_user_id ON accounts(user_id);
CREATE INDEX idx_accounts_username ON accounts(username);
CREATE INDEX idx_accounts_label ON accounts(label);
CREATE INDEX idx_accounts_active ON accounts(is_active);
```

---

## accounts/&lt;id&gt;/cache.db Schema (Cache + Sync)

All timestamps in cache/sync tables are **milliseconds since epoch** unless noted.

### Peer IDs

Every column that holds a chat holds its **marked peer ID**, the format mtcute uses and every
`tg` command prints:

| Chat | Marked ID | Example |
|------|-----------|---------|
| Private chat | the user ID | `5550001` |
| Basic group N | `-N` | `-4242` |
| Supergroup, channel or community N | `-1000000000000 - N` (`-100…`) | `-1001234567890` |

That covers `chats_cache.chat_id`, `messages_cache.chat_id`, `chat_sync_state.chat_id`,
`sync_jobs.chat_id` and `history_ranges.chat_id`, and the senders in `messages_cache.from_id`
and `forward_from_id`: a group or channel that posts as itself has its marked ID there too.
When Telegram leaves the sender out, `from_id` is the chat, as mtcute gives it to live messages:
the user for an incoming private message, your own user in Saved Messages, the channel for a
channel post.
`users_cache.user_id` is the same number as the `chat_id` of the private chat with that user.
`chats_cache.chat_id` is TEXT and the others are INTEGER, so a join compares
`chats_cache.chat_id = CAST(m.chat_id AS TEXT)`, which uses the primary key. All conversions live
in `src/utils/telegram-peer-ids.ts`.

### raw_json

`users_cache`, `chats_cache` and `messages_cache` keep the Telegram object as mtcute gives it in
`raw_json`. Every write goes through one serializer, `toRawJson` in `src/utils/raw-json.ts`:

- A byte array (`fileReference`, the stripped thumbnail in
  `photoStrippedSize.bytes` and others) is a base64 string.
- A `bigint` is a decimal string. mtcute's 64-bit IDs and hashes (`Long`) stay objects with
  `low`, `high` and `unsigned`.
- Everything else is what `JSON.stringify` writes.

Rows written by 0.5.0 and older keep their byte fields as objects with one key per byte
(`{"0":12,"1":250,…}`) until the row is fetched again. `tg sql` reads a byte field with
`json_extract`, for example the stripped thumbnails of photo messages:

```sql
SELECT message_id,
       json_extract(raw_json, '$.media.photo.sizes[0].bytes') AS stripped_thumb_base64
FROM messages_cache
WHERE json_extract(raw_json, '$.media.photo.sizes[0]._') = 'photoStrippedSize';
```

### Table: users_cache

```sql
CREATE TABLE users_cache (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  display_name TEXT,
  phone TEXT,
  access_hash TEXT,
  is_contact INTEGER DEFAULT 0,
  is_bot INTEGER DEFAULT 0,
  is_premium INTEGER DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX idx_users_cache_username ON users_cache(username) WHERE username IS NOT NULL;
CREATE INDEX idx_users_cache_phone ON users_cache(phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_users_cache_fetched_at ON users_cache(fetched_at);
```

### Table: chats_cache

```sql
CREATE TABLE chats_cache (
  chat_id TEXT PRIMARY KEY,      -- marked peer ID: user ID, -N, or -100… (see Peer IDs)
  type TEXT NOT NULL,            -- 'private', 'group', 'supergroup', 'channel', 'community'
  title TEXT,
  username TEXT,
  member_count INTEGER,
  access_hash TEXT,
  is_creator INTEGER DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  last_message_id INTEGER,
  last_message_at INTEGER,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX idx_chats_cache_username ON chats_cache(username) WHERE username IS NOT NULL;
CREATE INDEX idx_chats_cache_type ON chats_cache(type);
CREATE INDEX idx_chats_cache_fetched_at ON chats_cache(fetched_at);
CREATE INDEX idx_chats_cache_last_message_at ON chats_cache(last_message_at DESC);
```

A `community` is a Telegram community, a collection of linked chats (mtcute's `community` and
`communityForbidden`). It is stored with its channel ID and access hash like a channel, and
it is off for sync by default. Telegram lists a joined community apart from the other
dialogs, so the daemon's dialog pass (on start and after a reconnect) and
`tg chats list --fresh` cache every joined community with one more request,
`communities.getJoinedCommunities`, access hash included. A community has no messages of its
own: the dialog pass gives it no `chat_sync_state` row (only `tg chats sync --off` or `--auto`
writes one, with sync off), and its `last_message_id` and `last_message_at` stay NULL.

### Table: sync_state

Tracks global sync cursors (used for non-message entities).

```sql
CREATE TABLE sync_state (
  entity_type TEXT PRIMARY KEY,
  forward_cursor TEXT,
  backward_cursor TEXT,
  is_complete INTEGER DEFAULT 0,
  last_sync_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```

The only row so far is `contacts`, written by each full contact list (`tg contacts list
--fresh`): `last_sync_at` is when the list was last checked against Telegram, and
`forward_cursor` is Telegram's `saved_count` from the last full list. The `contacts.getContacts`
hash comes from that count and the IDs of the users with `is_contact = 1`. Without the row the
next check fetches the full list. A contact the full list leaves out keeps its `users_cache` row
with `is_contact = 0`.

### Table: messages_cache

```sql
CREATE TABLE messages_cache (
  chat_id INTEGER NOT NULL,      -- marked peer ID (see Peer IDs)
  message_id INTEGER NOT NULL,
  from_id INTEGER,               -- marked peer ID of the sender
  reply_to_id INTEGER,
  forward_from_id INTEGER,       -- marked peer ID of the original sender
  text TEXT,
  message_type TEXT NOT NULL DEFAULT 'text',
  has_media INTEGER DEFAULT 0,
  media_path TEXT,
  is_outgoing INTEGER DEFAULT 0,
  is_edited INTEGER DEFAULT 0,
  is_pinned INTEGER DEFAULT 0,
  is_deleted INTEGER DEFAULT 0,
  edit_date INTEGER,
  date INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX idx_messages_cache_date ON messages_cache(chat_id, date DESC);
CREATE INDEX idx_messages_cache_from ON messages_cache(from_id) WHERE from_id IS NOT NULL;
CREATE INDEX idx_messages_cache_reply ON messages_cache(chat_id, reply_to_id) WHERE reply_to_id IS NOT NULL;
CREATE INDEX idx_messages_cache_type ON messages_cache(chat_id, message_type) WHERE has_media = 1;
CREATE INDEX idx_messages_cache_pinned ON messages_cache(chat_id) WHERE is_pinned = 1;
CREATE INDEX idx_messages_cache_message_id ON messages_cache(message_id);
```

### Table: message_search

FTS5 index for message search.
Maintained via triggers on `messages_cache` and rebuilt when schema versions change. On
SQLite 3.43 and newer it is contentless: it holds only the index, its columns read as `NULL`,
and search joins `messages_cache` by rowid for the text ([search.md](search.md#a-contentless-index)).
With an older SQLite it is the full-content table, without the `content` options.

```sql
CREATE VIRTUAL TABLE message_search USING fts5(
  text,
  sender,
  chat,
  files,
  content='', contentless_delete=1,
  tokenize='unicode61'
);
```

### Table: search_meta

```sql
CREATE TABLE search_meta (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```

### Table: history_ranges

The message ID ranges of a chat that `messages_cache` holds without a gap. Each
`messages.getHistory` page the daemon or the CLI caches adds the range it covers; touching or
overlapping ranges merge, so the ranges of one chat never touch. `tg messages list` and `get`
answer from the cache only inside a range (see `docs/caching.md`).

```sql
CREATE TABLE history_ranges (
  chat_id INTEGER NOT NULL,
  low INTEGER NOT NULL,
  high INTEGER NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  PRIMARY KEY (chat_id, low)
);
```

### Table: chat_sync_state

```sql
CREATE TABLE chat_sync_state (
  chat_id INTEGER PRIMARY KEY,
  chat_type TEXT NOT NULL,       -- 'private', 'group', 'supergroup', 'channel', 'community'
  member_count INTEGER,
  forward_cursor INTEGER,
  backward_cursor INTEGER,
  sync_priority INTEGER NOT NULL DEFAULT 3,
  sync_enabled INTEGER NOT NULL DEFAULT 0,
  history_complete INTEGER DEFAULT 0,
  total_messages INTEGER,
  synced_messages INTEGER DEFAULT 0,
  last_forward_sync INTEGER,
  last_backward_sync INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  top_message_id INTEGER,
  sync_mode TEXT NOT NULL DEFAULT 'auto'
);

CREATE INDEX idx_chat_sync_state_enabled
  ON chat_sync_state(sync_enabled, sync_priority) WHERE sync_enabled = 1;
CREATE INDEX idx_chat_sync_state_priority ON chat_sync_state(sync_priority);
CREATE INDEX idx_chat_sync_state_incomplete
  ON chat_sync_state(chat_id) WHERE history_complete = 0 AND sync_enabled = 1;
```

- `forward_cursor`: every message up to this ID is cached. Only sync jobs move it, never live
  updates. `0` means the chat was empty at its first page.
- `sync_mode`: `auto` follows the sync policy; `on` and `off` are set with `tg chats sync` and
  win over the policy in every dialog pass. `sync_enabled` and `sync_priority` hold the result.
- `sync_priority`: the chat's tier, 1 (DMs and groups under 20 members), 2 (20–100 members) or
  3 (not synced unless turned on). It is also the priority of the chat's jobs inside each lane.
- `top_message_id`: the newest message ID Telegram reported, from the dialog pass or a sync
  page. `NULL` means unknown. Catch-up is due while it is `NULL` or above `forward_cursor`.

### Table: sync_jobs

```sql
CREATE TABLE sync_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  job_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 3,
  status TEXT NOT NULL DEFAULT 'pending',
  cursor_start INTEGER,
  cursor_end INTEGER,
  messages_fetched INTEGER DEFAULT 0,
  error_message TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  started_at INTEGER,
  completed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_sync_jobs_priority ON sync_jobs(priority, created_at) WHERE status = 'pending';
CREATE INDEX idx_sync_jobs_lane
  ON sync_jobs(job_type, priority, created_at, id) WHERE status = 'pending';
CREATE INDEX idx_sync_jobs_status ON sync_jobs(status);
CREATE INDEX idx_sync_jobs_chat ON sync_jobs(chat_id);
```

- `status`: `pending` includes jobs waiting for a retry. A `failed` job keeps its chat from
  getting a new job of the same type until it is deleted: by the daemon after
  `cache.retention.failedJobs` (24 hours by default) or on start, or by `tg chats sync` for its
  chat. Completed jobs are deleted after `cache.retention.completedJobs` (24 hours).
- `attempts`: failed tries so far. A FLOOD_WAIT or a daemon stop doesn't count; the fifth
  failure, or a permanent error, marks the job `failed`.
- `next_run_at`: when a pending job may run, in milliseconds since the epoch. `0` means now;
  a job that failed or hit a FLOOD_WAIT waits until then, and a job a daemon stop cut short
  keeps its own (see [sync-strategy.md](sync-strategy.md#retries)).
- `error_message`: the last error, kept while the job waits for its retry.
- Databases from 0.1.4 get `attempts` and `next_run_at` added with their defaults.

### Table: daemon_status

```sql
CREATE TABLE daemon_status (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```

The daemon writes each account's own rows, every second in one transaction per account:

| Key | Value |
|-----|-------|
| `daemon_pid`, `daemon_started_at`, `daemon_status` | The daemon that runs the account: its PID, start time, `running` or `stopped` |
| `daemon_version`, `daemon_version_pid` | The version of the daemon that started, and the PID that wrote it |
| `connection_status`, `last_error` | The account's connection (`connecting` from the start until the daemon's first write, then `connected`, `reconnecting`, `error`, `disconnected`) and its last error |
| `messages_synced` | Messages the daemon cached for this account since it started |
| `pending_jobs`, `running_jobs` | The account's queue; a start deletes the previous run's counts |
| `last_update` | When the daemon last wrote these rows |

`tg status` and `tg daemon status` count only rows whose `daemon_pid` is the PID in
`daemon.pid` of a live daemon; without one, `tg status` still reports the newest
`last_update`. The `connected_accounts` and `total_accounts` rows that 0.3 wrote are ignored.

- Daemons from 0.3.0 and older write neither version key, and none to `accounts/<id>/cache.db`.
- Stopping clears the PID, start time and version keys.
- Starting and stopping each write their keys in one transaction, and `tg status` reads them in
  one query, so it never sees a daemon half started or half stopped.
- `tg status` uses `daemon_version` only while `daemon_version_pid` equals `daemon_pid`.

### Table: rate_limits

```sql
CREATE TABLE rate_limits (
  method TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  call_count INTEGER DEFAULT 1,
  last_call_at INTEGER,
  flood_wait_until INTEGER,
  PRIMARY KEY (method, window_start)
);

CREATE INDEX idx_rate_limits_method ON rate_limits(method);
```

### Table: api_activity

```sql
CREATE TABLE api_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  method TEXT NOT NULL,
  success INTEGER NOT NULL,
  error_code TEXT,
  response_ms INTEGER,
  context TEXT
);

CREATE INDEX idx_api_activity_timestamp ON api_activity(timestamp DESC);
CREATE INDEX idx_api_activity_method ON api_activity(method);
```

`rate_limits` and `api_activity` are per account, like every table here: a FLOOD_WAIT on one
account, recorded or slept through inside a sync job, doesn't block another.

### Table: cache_meta

```sql
CREATE TABLE cache_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);
```

The owner stamp: `account_id` (the directory's `<id>`) and `user_id` (the Telegram user ID,
once the account knows it). The first open writes what is missing. A file stamped for another
account ID or another Telegram user is not opened; the command fails with `CACHE_UNAVAILABLE`
(`details.reason`: `owner_mismatch`), so a directory moved by hand, or a `data.db` recreated
with reused IDs, can't mix two accounts' data. The check needs `accounts.user_id`, which tg
fills in at login. One exception lets a re-login take its old cache back: a file stamped for
the same Telegram user and for an account ID that `data.db` no longer has (or that now belongs
to another user) is stamped for the account that opens it.

---

## Initialization

At startup the CLI/daemon ensures:

```sql
PRAGMA busy_timeout = 5000;          -- data.db and every accounts/<id>/cache.db
PRAGMA auto_vacuum = INCREMENTAL;    -- accounts/<id>/cache.db; takes effect on a new file only
PRAGMA journal_mode = WAL;
PRAGMA journal_size_limit = 67108864; -- 64 MB, data.db and every cache.db
```

A cache file this version creates has incremental auto_vacuum, so `tg db vacuum` can release
its free pages in short steps while the daemon runs. `auto_vacuum` must be set before a file
gets its first table, so an older cache keeps `none` until a full `tg db vacuum` (daemon
stopped) rewrites it. `journal_size_limit` makes a checkpoint shrink the WAL back to 64 MB at
most; without it a WAL that grew during a VACUUM or behind a long reader stays that size.
`tg status` reports each cache's `auto_vacuum` mode and free pages
([cli-commands.md](cli-commands.md#daemon--status--sql)).

The CLI and the daemon write the same account's `cache.db` at the same time, so a write waits
up to 5 seconds for the other process's write lock instead of failing with "database is
locked". `data.db` sets its timeout before any write, because the move of a shared cache (see
below) holds its write lock. The switch to WAL itself doesn't wait: when several processes open
a file that is not in WAL yet (a new file, or the cache the move just folded to `DELETE`),
SQLite fails all but one switch with `SQLITE_BUSY` at once, so the others try again every
10 ms for up to 5 seconds (`enableWal` in `src/db/schema.ts`).

## Migrations

The schema is created with `CREATE TABLE IF NOT EXISTS` on startup, indexes with
`CREATE INDEX IF NOT EXISTS`. Columns added after 0.1.4 (`chat_sync_state.top_message_id`,
`chat_sync_state.sync_mode`, `sync_jobs.attempts`, `sync_jobs.next_run_at`) are added with
`ALTER TABLE … ADD COLUMN` when missing; a "duplicate column name" error is ignored, because
the CLI and the daemon can both run the migration on the first start. Older binaries ignore
the new columns. `idx_messages_cache_message_id` is built on the first open of a cache
that lacks it. The build reads the whole table under the write lock, so that open, and any
other process opening the cache meanwhile, waits up to 60 seconds for the lock instead of 5;
the process that waited finds the index built. Opens of a cache that has it only read.

The search update trigger `messages_cache_au` of 0.5.0 and older re-indexed a message on every
update, and `idx_messages_cache_fetched` (`messages_cache(fetched_at)`) served no query. The
first open of such a cache by a newer version replaces the trigger with one that re-indexes
only a changed text, sender or media path ([search.md](search.md#triggered-indexing)) and drops
the index. It finds the old trigger by its SQL in `sqlite_master` and does both in one
`BEGIN IMMEDIATE` transaction, waiting up to 60 seconds for the lock and checking again inside;
opens that find the new trigger and no such index only read. The index's pages stay in the
file as free pages until `tg db vacuum`.

`PRAGMA user_version` records the one-time data migrations of each account's `cache.db`
(`src/db/peer-id-migration.ts`); they run on every account's file on its first open:

- `1`: up to 0.2.0, `chats_cache` stored groups and channels under their bare positive IDs. Each
  such row moves to its marked ID, taken from its `raw_json` (a dialog's peer or a raw chat) when
  that names the same chat, otherwise from its `type`. When a chat is cached under both IDs, the
  row fetched later wins and keeps the other's access hash if it has none. The search index is
  then rebuilt, so its `chat` column holds group and channel titles.
- `2`: history pages, `tg send` and live forwards stored a group or channel sender in
  `messages_cache.from_id` and `forward_from_id` under its bare ID. A row moves to the marked ID
  when its `raw_json` names that group or channel (`fromId`, `fwdFrom.fromId`) with the stored
  bare ID; rows whose `raw_json` is `{}` or malformed stay as they are. The update trigger
  re-indexes each row.
- `3`: history pages, `tg messages list`/`get` and `tg send` stored NULL in
  `messages_cache.from_id` for a message Telegram sends without `fromId`. A row whose `raw_json`
  names its chat (`peerId`) and no `fromId` gets the chat as the sender, by the rule in
  [Peer IDs](#peer-ids); rows whose `raw_json` is `{}` or malformed stay NULL. The update trigger
  re-indexes each row.

The first open after an upgrade runs the steps in one `BEGIN IMMEDIATE` transaction, waiting up
to 60 seconds for another process's write lock. A failure rolls everything back, `user_version`
included, and the next open tries again. The move of bare `chats_cache` rows also runs on every
later open that finds one, which repairs rows that an older daemon still running writes. Steps
`2` and `3` run once, because finding those senders means reading the `raw_json` of every
message. A group or channel sender or forward source that an older daemon still running, or a
second 0.2.0 install, caches after the upgrade keeps its bare ID until the message is fetched
again. A daemon of the previous version left running keeps storing NULL senders until it
restarts, and those rows heal only when the message is fetched again. Step `3` rewrites and
re-indexes every row it fills, several seconds per 100,000 messages, while it holds the write
lock, and that daemon waits only 5 seconds for it before a write fails. Stop the daemon before
upgrading and start it again after, so the old daemon neither loses writes to the one-time fill
nor stores new messages without a sender. Opens with nothing to do only read. Going back to an older version after the migration is not supported: it would not
find groups and channels in `chats_cache`.

### From the shared cache of 0.3 and older

Up to 0.3 every account shared one `<dataDir>/cache.db`. Its rows have no account column, so
they can't be split by account. The first command that needs a cache (and `tg status`,
`tg daemon status`, `tg daemon start`) moves it, once per process (`src/db/cache-layout.ts`).
So do `tg auth login`, `login-qr`, `logout` and `tg accounts remove`, before they change the
accounts, and they fail with `CACHE_UNAVAILABLE` and change nothing while the file can't move
yet, whatever the count: a login that adds a second account would force the first one's file
aside, and a removal that leaves one account (or a login that adds the first) would hand it
rows that other accounts wrote.

1. Without a root `cache.db` nothing happens: one `stat`, no lock, no write.
2. The process takes `data.db`'s write lock (`BEGIN IMMEDIATE`, waiting up to 60 seconds), so
   processes of this version take turns and the accounts can't change mid-way, and checks for
   the file again.
3. It opens the file without creating it and switches it to `journal_mode = DELETE`. That folds
   the WAL into the file and works only while no other process has it open, even an idle one,
   so it also proves no older tg is using it. A non-empty `-wal` left afterwards means the same.
   It then deletes the empty `-wal` and the `-shm`. Only a file that is not a database or is
   malformed (`SQLITE_NOTADB`, `SQLITE_CORRUPT`) skips the fold and is set aside as it is.
4. It decides:
   - **Adopt**: with exactly one account and no `accounts/*/cache.db` yet, it renames the file
     to `accounts/<id>/cache.db`. Every cursor, history range, job, retry, sync mode, rate limit
     and search row carries over; the first open stamps `cache_meta` and runs the
     `user_version` steps above.
   - **Delete**: otherwise, a file with no rows in `messages_cache`, `chats_cache`,
     `users_cache`, `chat_sync_state`, `history_ranges` and `sync_jobs` is deleted.
   - **Set aside**: any other file is renamed to the first free name of `shared-cache.db`,
     `shared-cache-2.db`, … (rename would overwrite, so the name is checked under the lock).
     It is never merged into an account. One line on stderr says where it went (none with
     `--format quiet`), the daemon logs it, and `tg status` lists it under `storage`.
5. It commits. The file is renamed, never copied.

A file that a newer run finds after `accounts/<id>/cache.db` already exists (an older binary
wrote it after the move) is set aside or deleted the same way, never merged.

When another process still has the shared file open, adopting fails the command with
`CACHE_UNAVAILABLE` (`details.reason`: `shared_cache_in_use`) and changes nothing: creating an
empty per-account cache first would force the shared file aside later. Setting aside waits
instead: a cache command goes on and a later run moves the file, while a command that changes
the accounts fails as above. Any other error is `move_failed`
and is handled the same way, with nothing changed: a fold that fails (a read-only file, a full
disk, an I/O error) or a failed `mkdir`, rename or delete (`EXDEV`, `EACCES`). So a single
account never starts an empty cache because of an error that a retry may not have. `tg status`
reports a waiting move under `storage.migration`.

Handing a set-aside file to an account by hand: stop the daemon, move the account's
`accounts/<id>/cache.db`, `-wal` and `-shm` away, then move `shared-cache.db` to
`accounts/<id>/cache.db`. The folded file has no sidecars. tg stamps it for that account on
the next open. It carries every account's rows from before the upgrade, which tg then serves
as that account's, foreign access hashes included: hand it over only when a single account
synced into it, and otherwise read it as an archive with `sqlite3`.

A single account that adopts the shared file may inherit rows that accounts removed earlier
left in it; they can't be told apart. Going back to 0.3 or older after the move is not
supported: it would start an empty shared cache.

## Usage Notes

- **Messages are eternal** — message rows are not expired; `is_deleted` marks deletions.
- **Peers expire** — users/chats are considered stale based on TTL and can be refreshed on demand.
- **raw_json is always stored** — all cached entities keep the original TL payload.
- **Rate limits** — tracked per method + window with optional flood wait.
- **Retention** — the daemon prunes `api_activity`, `rate_limits` and finished `sync_jobs` by
  `cache.retention.*` ([daemon.md](daemon.md#cache-pruning)); messages are never pruned.
- **Message search** — FTS5 index maintained via triggers on `messages_cache`.

## Capacity Planning (Approx.)

Measured on 20,000 made-up messages written through `upsertBatch` (SQLite 3.54.0, 4 KB pages),
bytes per message as `tg status --sizes` reports them (indexes counted with their table):

| Messages | `messages_cache` | `message_search` full-content | `message_search` contentless | File, contentless |
|----------|------------------|-------------------------------|------------------------------|-------------------|
| Text only, 3–32 words | ~910 B | ~330 B | ~100 B | ~1,020 B (18% smaller) |
| One in ten with a photo | ~1,740 B | ~320 B | ~100 B | ~1,850 B (11% smaller) |

`raw_json` (the stored TL object) was 43–61% of the file in this measurement, most of it in
media messages: byte arrays such as `fileReference` and the stripped thumbnail were stored as
objects with one key per byte, about 7.7 KB per synthetic photo message. Now they are base64
([raw_json](#raw_json)): the made-up photo message in the tests takes 1,896 bytes instead of
10,213.

| Data Type | Records | Est. Size |
|-----------|---------|-----------|
| users_cache | 500 | ~0.5 MB |
| chats_cache | 200 | ~0.2 MB |
| messages_cache + message_search (per chat) | 10,000 | ~10–20 MB |
| messages_cache + message_search (50 synced chats) | 500,000 | ~0.5–1 GB |
| api_activity (7 days) | 10,000 | ~5 MB |

## Future Enhancements

- Media cache table with eviction policy
- Drafts / reactions tables
