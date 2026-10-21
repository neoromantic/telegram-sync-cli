# Daemon

> **Status: Implemented (v0.1.0)** — current daemon behavior. For schema details, see `docs/database-schema.md`.

## Overview

The `tg daemon` subcommand runs a long-lived process that:
- Maintains MTProto connections for configured accounts
- Processes real-time updates (new/edit/delete messages)
- Bootstraps dialogs on startup and after each reconnect (seed `chats_cache` +
  `chat_sync_state`, archived chats included)
- Schedules message sync jobs (forward catchup + backfill)
- Writes only to local cache/sync tables (read-only to Telegram)

**Key Principles:**
- **READ-ONLY**: The daemon never performs mutations (no sending/editing messages)
- **Foreground execution**: Users manage backgrounding (tmux, systemd, etc.)
- **Multi-account**: Connects all configured accounts (soft limit planned)
- **Resilient**: Reconnects with backoff; retries failed sync jobs with backoff; handles rate
  limits

---

## Command Interface

```bash
# Start daemon in foreground
tg daemon start

# Verbosity control
tg daemon start --verbose
tg daemon start --quiet

# Stop daemon
tg daemon stop

# Stop with timeout/force
tg daemon stop --timeout 20
tg daemon stop --force

# Status
tg daemon status
```

### Daemon PID

PID file location:
- `~/.telegram-sync-cli/daemon.pid`
- Respecting `TELEGRAM_SYNC_CLI_DATA_DIR` override

---

## Architecture (Current)

### Process Model

```
┌──────────────────────────────────────────────┐
│                tg daemon                     │
├──────────────────────────────────────────────┤
│  Account Connections (mtcute clients)        │
│    - per-account session_<id>.db             │
│    - reconnection + backoff                  │
│                                              │
│  Update Handlers                             │
│    - onNewMessage / onEditMessage / onDelete │
│                                              │
│  Sync Scheduler                              │
│    - enqueues sync_jobs                      │
│                                              │
│  Sync Worker                                 │
│    - forward catchup + backward history      │
│                                              │
│  Cache/Sync DB (cache.db)                    │
└──────────────────────────────────────────────┘
```

### Update Handling

Real-time handlers update `messages_cache` and `chat_sync_state`:
- New message → insert/update message row
- Edit message → update text/edit_date
- Delete message → mark `is_deleted = 1`

Handlers live in:
- `src/daemon/handlers.ts`
- `src/daemon/daemon-accounts.ts`

### Sync Scheduling

The scheduler decides which chats to sync and creates jobs in `sync_jobs`:
- Forward catchup for chats that are behind: their newest message (`top_message_id`, from the
  dialog pass) is above the forward cursor or unknown. It runs on start, after each reconnect
  and until a gap is closed, not as polling; a chat that is caught up costs no calls.
- A first page (`initial_load`) for chats without a forward cursor
- Large groups and channels only when turned on with `tg chats sync`; the daemon picks up
  the change at its next refresh
- Backward history for older messages
- Three lanes (catch-up, first pages, history) that take turns, so history makes progress
  next to catch-up; inside a lane, small chats go first
- A refresh every ~30 seconds (daemon loop) and after each reconnect's dialog pass queues
  the work that is due again, such as chats first seen live

See [sync-strategy.md](sync-strategy.md) for the rules.

Key files:
- `src/daemon/scheduler.ts`
- `src/daemon/daemon-scheduler.ts`
- `src/db/sync-jobs.ts`
- `src/daemon/daemon-bootstrap.ts`

### Sync Worker

Workers execute jobs and update:
- `messages_cache`
- `chat_sync_state` (cursors, progress)

Key files:
- `src/daemon/sync-worker-core.ts`
- `src/daemon/sync-worker-real-jobs.ts`
- `src/daemon/sync-worker-real-context.ts`
- `src/daemon/sync-retry.ts` (backoff and permanent errors)

---

## Status Output

`tg daemon status` returns:
- `status` (`running`/`stopped`)
- `pid`
- `uptime`
- `connectedAccounts` / `totalAccounts`
- `messagesSynced` (since daemon start, realtime + backfill)
- `messagesSyncedTotal` (sum of `chat_sync_state.synced_messages`)
- `messagesCached` (rows in `messages_cache`)
- `chatsEnabled`
- `chatsHistoryComplete`
- `lastUpdate`

---

## Data Flow

### Real-time Updates

```
Telegram Updates → mtcute events → handlers → messages_cache + chat_sync_state
```

### Background Sync

```
Scheduler → sync_jobs → worker → messages_cache + chat_sync_state
```

---

## Error Handling & Resilience

- Checks each idle account's connection about once a minute; a failed check
  schedules a reconnect with exponential backoff
- A reconnect closes the old client before it opens a new one on the same
  session file, registers the update handlers on the new client, starts its
  updates loop and rebuilds the account's sync worker; a failed attempt closes
  the new client and schedules the next retry
- After a reconnect, a dialog pass runs on the new client in the background
  (one per account at a time), then the scheduler catches up the chats that got
  messages while the connection was down. If the pass fails part-way, every
  synced chat it didn't list gets one checking page; a chat turned on with
  `tg chats sync` that it didn't list gets one either way
- A sync job that fails retries after 1, 2, 4 and 8 minutes and is marked failed after the
  fifth attempt; a permanent error (such as `CHANNEL_PRIVATE`) fails it at once, and a
  FLOOD_WAIT only delays it. A failed job's chat isn't queued again for that job type until
  the daemon deletes the failed row: after 24 hours or on the next start. Each failure is
  logged as a warning (see [sync-strategy.md](sync-strategy.md#retries))
- Tracks last activity to avoid noisy health checks
- Validates sync job state transitions
- Uses rate limit service with flood wait tracking

---

## Implementation References

- `src/daemon/` — daemon core
- `src/db/sync-schema.ts` — sync tables
- `src/db/sync-jobs.ts` — job queue
- `src/db/chat-sync-state.ts` — per-chat sync state
