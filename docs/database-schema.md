# Database Schema

## Overview

This document defines the current on-disk schema used by telegram-sync-cli. It follows these principles:

> **Tip:** Use `tg sql print-schema --output=sql` to get the live schema with annotated comments explaining each column and its semantic type.

1. **Local-first** — all data is stored locally via SQLite
2. **raw_json for future-proofing** — cached entities keep the original TL object
3. **Stale-while-revalidate** — cached data is returned immediately, refreshed on demand

> **Note:** A per-account directory layout is not implemented yet.
> The current implementation uses a single data directory with per-account session files.

## File Structure

Default data directory: `~/.telegram-sync-cli` (override with `TELEGRAM_SYNC_CLI_DATA_DIR`).

```
~/.telegram-sync-cli/
├── data.db            # Accounts table
├── cache.db           # Cache + sync tables
├── session_<id>.db    # mtcute session per account
├── daemon.pid         # PID file when daemon is running
└── config.json        # User config (cache TTLs, active account)
```

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

## cache.db Schema (Cache + Sync)

All timestamps in cache/sync tables are **milliseconds since epoch** unless noted.

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
  chat_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,            -- 'private', 'group', 'supergroup', 'channel'
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

### Table: messages_cache

```sql
CREATE TABLE messages_cache (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  from_id INTEGER,
  reply_to_id INTEGER,
  forward_from_id INTEGER,
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
CREATE INDEX idx_messages_cache_fetched ON messages_cache(fetched_at);
```

### Table: message_search

FTS5 index for message search.
Maintained via triggers on `messages_cache` and rebuilt when schema versions change.

```sql
CREATE VIRTUAL TABLE message_search USING fts5(
  text,
  sender,
  chat,
  files,
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
  chat_type TEXT NOT NULL,
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
  getting a new job of the same type until the daemon deletes it: after 24 hours or on start.
- `attempts`: failed tries so far. A FLOOD_WAIT doesn't count; the fifth failure, or a
  permanent error, marks the job `failed`.
- `next_run_at`: when a pending job may run, in milliseconds since the epoch. `0` means now;
  a job that failed or hit a FLOOD_WAIT waits until then (see
  [sync-strategy.md](sync-strategy.md#retries)).
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

---

## Initialization

At startup the CLI/daemon ensures:

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;  -- cache.db only
```

The CLI and the daemon write `cache.db` at the same time, so a write waits up to 5 seconds for
the other process's write lock instead of failing with "database is locked".

## Migrations

There is no `schema_version` table yet. The schema is created with `CREATE TABLE IF NOT EXISTS`
on startup, indexes with `CREATE INDEX IF NOT EXISTS`. Columns added after 0.1.4
(`chat_sync_state.top_message_id`, `chat_sync_state.sync_mode`) are added with
`ALTER TABLE … ADD COLUMN` when missing; a "duplicate column name" error is ignored, because
the CLI and the daemon can both run the migration on the first start. Older binaries ignore
the new columns.

## Usage Notes

- **Messages are eternal** — message rows are not expired; `is_deleted` marks deletions.
- **Peers expire** — users/chats are considered stale based on TTL and can be refreshed on demand.
- **raw_json is always stored** — all cached entities keep the original TL payload.
- **Rate limits** — tracked per method + window with optional flood wait.
- **Message search** — FTS5 index maintained via triggers on `messages_cache`.

## Capacity Planning (Approx.)

| Data Type | Records | Est. Size |
|-----------|---------|-----------|
| users_cache | 500 | ~0.5 MB |
| chats_cache | 200 | ~0.2 MB |
| messages_cache (per chat) | 10,000 | ~10 MB |
| messages_cache (50 synced chats) | 500,000 | ~500 MB |
| api_activity (7 days) | 10,000 | ~5 MB |

## Future Enhancements

- Media cache table with eviction policy
- Drafts / reactions tables
- Automated cleanup for `api_activity`
