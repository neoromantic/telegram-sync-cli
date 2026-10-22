# Daemon

> **Status: Implemented (v0.1.0)** — current daemon behavior. For schema details, see `docs/database-schema.md`.

## Overview

The `tg daemon` subcommand runs a long-lived process that:
- Maintains MTProto connections for configured accounts
- Processes real-time updates (new/edit/delete messages)
- Bootstraps dialogs on startup and after each reconnect (seed `chats_cache` +
  `chat_sync_state`, archived chats included)
- Schedules message sync jobs (forward catchup + backfill)
- Keeps each account's contact list current: a background check on start, after each
  reconnect and by the peer TTL with Telegram's hash, so an unchanged list costs one tiny reply (see [Contacts sync](#contacts-sync))
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

`tg daemon` reads no key of `config.json` and skips the start-up check of that file that other
commands run, so an invalid or unreadable one doesn't stop `tg daemon start`, `--quiet` included
(see [configuration.md](configuration.md#runtime-behavior)).

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
│  Job loop per account: one job at a time,    │
│  3 s between its jobs                        │
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

Real-time handlers update `messages_cache`, `chat_sync_state` and, for contacts,
`users_cache` in the receiving account's cache:
- New message → insert/update message row
- Edit message → update text/edit_date
- Delete message → mark `is_deleted = 1` (without a chat: the one private chat or basic group
  with that ID; see [real-time.md](real-time.md#deletes))
- Contact signals (`updatePeerSettings`, `updateUser` with the user's full record) → set
  `users_cache.is_contact` when the flag changed; without the full record, a hash check of the
  contact list a minute later; `updateContactsReset` → unmark every contact and check the list
  (see [real-time.md](real-time.md#contacts))

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
- Each account runs its own jobs: one at a time, the next one 3 seconds after its last one
  ended. On the 1-second tick the daemon starts an account's next job when it has none
  running, its client is connected, it isn't waiting out a FLOOD_WAIT recorded in its
  `rate_limits` and its delay has passed. A FLOOD_WAIT that mtcute sleeps through inside a
  job (up to 5 minutes), a recorded one (over 5 minutes) or a slow page holds only that
  account; the others keep syncing. One account's lost connection doesn't stop the others; a
  disconnected account's jobs stay pending until it reconnects. An account whose cache fails
  while its next job is picked (a corrupt page, a lock held past the 5-second
  `busy_timeout`) is logged, waits out its delay and is tried again; the other accounts go on.
  A FLOOD_WAIT on one account's health-check `getMe` still pauses new job starts for every
  account until it ends

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

### Contacts sync

The daemon keeps each connected account's contact list in its own cache (`users_cache.is_contact`)
([#8](https://github.com/neoromantic/telegram-sync-cli/issues/8)). It only reads from Telegram:
`contacts.getContacts`.

- **When:** the main loop looks on its first tick, right after the startup dialog pass, and then
  every 30 ticks (~30 seconds). A check is due when the account has no recorded list, when the
  list is older than the peer TTL (`cache.staleness.peers`, one week by default), after each
  start and reconnect of the account, or when an update hinted at a change without the user's
  full record (a minute after the first hint; later hints in that minute share the check). A
  hint, or a contact change written from a full record, that arrives while a check runs gets a
  check of its own a minute later, because that check's reply may predate the change. The
  start and reconnect checks are there because the daemon's clients don't replay updates
  missed while they were down (mtcute's `catchUp` is off), so a contact deleted on your phone
  meanwhile reaches the cache only through a check; an unchanged list costs one tiny reply.
  The TTL is read when the daemon starts, so a change to it needs a restart. Most looks read
  one row of `sync_state` and do nothing.
- **Hash:** the request carries Telegram's hash of the cached list: the `saved_count` of the last
  full list and the IDs of the cached contacts. An unchanged list gets `contactsNotModified`
  back, a few bytes, and only `sync_state.last_sync_at` moves. Because the hash comes from the
  cache, any drift (a contact edited through `tg api contacts.*`, a missed update, a
  `--fresh` from another process) makes it differ, and Telegram sends the full list.
- **Full list:** applied as `tg contacts list --fresh` applies it: listed users are marked,
  cached contacts it leaves out are unmarked and keep their row
  ([contacts.md](contacts.md#removed-contacts)).
- **In the background:** a check never holds the job loop. One check per account runs at a
  time.
- **Backoff:** a FLOOD_WAIT longer than the 5 minutes the client sleeps through is recorded in
  the account's `rate_limits` (the CLI sees it too) and the account isn't checked again until
  it ends. Any other error is logged as a warning and the account is checked again after 15
  minutes, or at once after its next reconnect; `last_sync_at` stays as it was. A check that
  fails because the connection dropped is logged at debug level, and the reconnect's check runs
  right away.
- **Stop:** the request gets the daemon's stop signal. A check that ends during a stop writes
  nothing.

Database growth: an unchanged list costs one small request and one `sync_state` UPDATE per
account per check (every TTL, plus one per start and reconnect). A changed list rewrites the contact rows in place and runs one UPDATE for the
removed contacts. New rows come only from new contacts. Nothing is deleted, and `sync_state`
holds one row per account cache.

Key files:
- `src/daemon/daemon-contacts.ts`
- `src/db/contacts-sync.ts`

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
- `storage`: the same `{ legacy_caches, migration }` as in `tg status`. While the shared cache
  of 0.3 waits to move (`migration.reason` `shared_cache_in_use`, typically a 0.3 daemon still
  running after an upgrade), no account has its cache yet and every figure above reads 0;
  `migration.suggestion` says what to do (`tg daemon stop`)

The daemon writes each account's figures to that account's `daemon_status` rows every second,
in one transaction per account (keys: [database-schema.md](database-schema.md#table-daemon_status)),
and marks every account stopped on shutdown. A start marks each account `connecting` and drops
the previous run's error and job counts, then writes each account's connection right after
connecting, before the dialog pass that can take minutes, and again once the schedulers run. Only rows whose `daemon_pid` is the PID of the
live daemon in `daemon.pid` count, so a stopped daemon's leftovers never do. The one exception
is `tg status`'s `daemon.last_update`: without a live daemon it is the newest `last_update` any
account's rows have, so a stopped daemon still says when it last ran.

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
- On shutdown (`tg daemon stop`, SIGTERM or SIGINT) the daemon ends the
  request each account's running sync job is waiting on and waits for those
  jobs; they stay pending. It then closes every account's client once. The
  session files stay open until then: closing a client stops its updates loop,
  saves its update state and peers, and closes its session file and Telegram
  connections, and the update handlers stay on until it's done, so updates and
  peers that arrive after the signal are saved. If waiting for the jobs and
  closing the clients takes longer than 30 seconds, the daemon exits with
  code 1 and still saves the queued session writes. A stop ends the dialog
  pass at the next dialog, and a request that the pass or a
  sync job is waiting on ends at once, a FLOOD_WAIT of up to 5 minutes
  included: the pass counts as stopped and marks nothing, and the job is
  pending as it was, with no attempt used, so the next start runs it again.
  A FLOOD_WAIT in the startup connect (the client start or `getMe`) or in the
  health check's `getMe` still holds the stop until it ends; one in a reconnect
  ends when the shutdown closes that client. If the daemon
  hasn't exited within `tg daemon stop`'s `--timeout` (10 seconds by default),
  the command reports `DAEMON_SHUTDOWN_TIMEOUT` and the daemon keeps shutting
  down on its own; a longer `--timeout` waits for it, and with `--force` the
  command kills the daemon instead, which loses the session writes made since
  the last save
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
- Waits to reconnect an account until its running sync job ends
- Validates sync job state transitions
- Uses rate limit service with flood wait tracking

---

## Implementation References

- `src/daemon/` — daemon core
- `src/db/sync-schema.ts` — sync tables
- `src/db/sync-jobs.ts` — job queue
- `src/db/chat-sync-state.ts` — per-chat sync state
