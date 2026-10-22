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
- **Multi-account**: Connects all configured accounts (soft limit planned). Each account has
  its own cache, `accounts/<id>/cache.db`, and its own scheduler and sync worker
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
│  Job loop: one job per tick, accounts take   │
│  turns, 3 s between one account's jobs       │
├──────────────────────────────────────────────┤
│  Account runtime (one per account)           │
│    - mtcute client, session_<id>.db          │
│    - reconnection + backoff                  │
│    - update handlers                         │
│      (onNewMessage / onEditMessage / onDelete)│
│    - sync scheduler: enqueues sync_jobs      │
│    - sync worker: forward catchup + history  │
│    - cache, sync state, jobs, rate limits:   │
│      accounts/<id>/cache.db                  │
└──────────────────────────────────────────────┘
```

At start the daemon moves the shared cache of 0.3 and older (see
[database-schema.md](database-schema.md#from-the-shared-cache-of-03-and-older)); if an older
tg still holds it and there is one account, the daemon exits with an error. It then opens every
account's cache. An account whose cache doesn't open (another account's file, a corrupt one) is
logged, shown with status `error` and not connected; the others run. With no cache open the
daemon exits with `AllAccountsFailed`. After the connections and the dialog pass, each
connected account gets its scheduler; if one account's startup pass fails (for example its
cache stays locked), that is logged, the account still runs its pending jobs and the next
refresh queues the rest, and the other accounts start as usual.

Everything an account receives or syncs lands only in its own cache: a live message, an edit,
a delete without chat context, a dialog pass, a sync job. A job queued in an account's cache
runs only on that account's client, with that account's access hashes and rate limits.

### Update Handling

Real-time handlers update `messages_cache` and `chat_sync_state` in the receiving account's
cache:
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
- The job loop takes turns between accounts: each tick it runs the next job of the first
  account after the one that ran last whose client is connected, which isn't waiting out a
  FLOOD_WAIT, and whose own 3-second delay since its last job has passed. One account's
  FLOOD_WAIT or lost connection doesn't stop the others; a disconnected account's jobs stay
  pending until it reconnects. Jobs still run one at a time, so with three or more busy
  accounts each one syncs more slowly

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

`tg daemon status` returns totals over every account's cache:
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
- `accounts[]`: each account's `id`, `connection` and `lastError` (from a live daemon, else
  `null`), `messagesSynced`, `messagesCached`, `chatsEnabled` and `chatsHistoryComplete`

The daemon writes each account's figures to that account's `daemon_status` rows every second,
in one transaction per account (keys: [database-schema.md](database-schema.md#table-daemon_status)),
and marks every account stopped on shutdown. Only rows whose `daemon_pid` is the PID of the
live daemon in `daemon.pid` count, so a stopped daemon's leftovers never do.

### Upgrading

A running daemon keeps the code it started with. To upgrade, stop the daemon, upgrade tg and
start the daemon again. The daemon records its version when it starts, and `tg status` says when
the running daemon is another version: `daemon.version_mismatch` in JSON, and a Version row with
the advice in `--format pretty`. `tg daemon status` doesn't report it. A daemon of 0.3 or older
writes nothing to the per-account caches, so it shows up instead as the shared-cache move that
waits for it (`storage.migration`, `shared_cache_in_use`) in both status commands.

---

## Data Flow

### Real-time Updates

```
Telegram Updates → account's mtcute client → handlers → that account's messages_cache + chat_sync_state
```

### Background Sync

```
account's scheduler → its sync_jobs → its worker and client → its messages_cache + chat_sync_state
```

---

## Error Handling & Resilience

- Checks each idle account's connection about once a minute; a failed check
  schedules a reconnect with exponential backoff
- An account whose first connect fails (login, `getMe` or the updates loop)
  has its client closed right away, so its connection and session file aren't
  left open until the daemon stops
- A reconnect closes the old client before it opens a new one on the same
  session file, registers the update handlers on the new client, starts its
  updates loop and rebuilds the account's sync worker; a failed attempt closes
  the new client and schedules the next retry
- On shutdown (`tg daemon stop`, SIGTERM or SIGINT) the daemon closes every
  account's client once, which stops its updates loop and closes its Telegram
  connections. mtcute itself saves and closes the session files when the
  signal arrives
- After a reconnect, a dialog pass runs on the new client in the background
  (one per account at a time), then the scheduler catches up the chats that got
  messages while the connection was down. If the pass fails part-way, every
  synced chat it didn't list gets one checking page; after a complete pass the
  account's chats it didn't list are marked caught up. A chat turned on with
  `tg chats sync` that it didn't list gets a checking page either way
- A sync job that fails retries after 1, 2, 4 and 8 minutes and is marked failed after the
  fifth attempt; a permanent error (such as `CHANNEL_PRIVATE`) fails it at once, and a
  FLOOD_WAIT only delays it. A failed job's chat isn't queued again for that job type until
  the failed row is deleted: after 24 hours, on the next start or by `tg chats sync <chat>`
  with the chat's current mode (`--auto` unless it was turned on; `tg status` prints the
  command). Each failure is logged as a warning (see [sync-strategy.md](sync-strategy.md#retries))
- Tracks last activity to avoid noisy health checks
- Validates sync job state transitions
- Uses rate limit service with flood wait tracking

---

## Implementation References

- `src/daemon/` — daemon core
- `src/db/sync-schema.ts` — sync tables
- `src/db/sync-jobs.ts` — job queue
- `src/db/chat-sync-state.ts` — per-chat sync state
