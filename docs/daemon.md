# Daemon

> **Status: Implemented (v0.1.0)** — current daemon behavior. For schema details, see `docs/database-schema.md`.

## Overview

The `tg daemon` subcommand runs a long-lived process that:
- Maintains MTProto connections for configured accounts
- Processes real-time updates (new/edit/delete messages)
- Bootstraps dialogs on startup (seed `chats_cache` + `chat_sync_state`)
- Schedules message sync jobs (forward catchup + backfill)
- Writes only to local cache/sync tables (read-only to Telegram)

**Key Principles:**
- **READ-ONLY**: The daemon never performs mutations (no sending/editing messages)
- **Foreground execution**: Users manage backgrounding (tmux, systemd, etc.)
- **Multi-account**: Connects all configured accounts (soft limit planned)
- **Resilient**: Reconnects with backoff; handles rate limits and errors

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
- Forward catchup for missed messages
- Backward history for older messages
- Priority-based execution (P0–P4)
- Periodic refresh to pick up newly discovered chats
  - Refresh interval: ~30 seconds (daemon loop)

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

- Reconnects with exponential backoff
- Tracks last activity to avoid noisy health checks
- Validates sync job state transitions
- Uses rate limit service with flood wait tracking

---

## Implementation References

- `src/daemon/` — daemon core
- `src/db/sync-schema.ts` — sync tables
- `src/db/sync-jobs.ts` — job queue
- `src/db/chat-sync-state.ts` — per-chat sync state
