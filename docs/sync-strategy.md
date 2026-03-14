# Sync Strategy

> **Status: Implemented (v0.1.0)** — current sync behavior implemented in `src/daemon/*` and `src/db/*`.

## Overview

The daemon synchronizes message history using a **dual cursor** system and a **persistent job queue**:

- **Forward cursor** tracks the newest synced message (catchup + realtime)
- **Backward cursor** tracks how far history backfill has progressed
- **sync_jobs** provides resumable, priority-based work

## Dual Cursor System

Each chat maintains two independent cursors:

```
Timeline: [oldest] ---- [backward_cursor] ---- [forward_cursor] ---- [newest]
           ^                                           ^
     History backfill                             Real-time updates
```

Stored in `chat_sync_state`:
- `forward_cursor` — latest synced message ID
- `backward_cursor` — oldest synced message ID
- `history_complete` — reached beginning of history

## Sync Priorities

### Priority Tiers

| Priority | Category | Sync Behavior |
|----------|----------|---------------|
| **P0** | Real-time | Immediate updates when daemon is running |
| **P1** | DMs + small groups (<20 members) | Full history sync |
| **P2** | Medium groups (20–100 members) | Initial load + gradual history |
| **P3** | Large groups (>100) & channels | On-demand only |
| **P4** | Background | Low-priority backfill |

### Policy (Current)

Implemented in `determineSyncPolicy`:

- `private` → enabled, **High**
- `group/supergroup`:
  - `< 20` → enabled, **High**
  - `20–100` → enabled, **Medium**
  - `> 100` → disabled, **Low**
- `channel` → disabled, **Low**

## Data Model

Core tables (see `docs/database-schema.md` for full schema):

- `chat_sync_state` — per-chat cursors + priority + progress
- `sync_jobs` — persistent job queue
- `messages_cache` — message storage

## Job Types

Implemented in `SyncJobType`:

- `forward_catchup` — fetch missed messages since `forward_cursor`
- `initial_load` — initial recent message window
- `backward_history` — backfill older history
- `full_sync` — full history job (used sparingly)

Job status values:
- `pending`, `running`, `completed`, `failed`

## Sync Flow (Current)

### Real-time

- Handlers listen to mtcute events immediately
- New messages update `messages_cache` and advance `forward_cursor`

### Catch-up + Backfill

0. **Bootstrap dialogs** on daemon startup (populate `chats_cache` + `chat_sync_state`)
1. Scheduler inspects `chat_sync_state`
2. Creates `sync_jobs` based on priority + gaps
3. Worker executes jobs using API calls (`messages.getHistory`)
4. Updates cursors and progress counters

The scheduler uses the database as the single source of truth. There is **no in-memory priority queue**.

## Batch Size

Sync jobs use a default batch size of **100 messages** (configurable in worker config).

## Rate Limiting

Rate limits are tracked per API method:
- `rate_limits` table stores call count + flood wait
- Workers and CLI calls share the same rate-limit service

## Notes

- Catchup and realtime run concurrently; realtime handlers do not wait for catchup to complete.
- Medium-group initial load size is governed by worker batch size (currently 100), not a fixed “10 messages” rule.
- Daemon bootstraps dialogs on startup to seed `chats_cache` + `chat_sync_state`.
- Scheduler refreshes job queues periodically to pick up newly discovered chats.
- Contact sync remains **CLI-driven**; the daemon does not refresh contacts.

## Implementation References

- `src/db/sync-schema.ts`
- `src/db/sync-jobs.ts`
- `src/db/chat-sync-state.ts`
- `src/daemon/scheduler.ts`
- `src/daemon/sync-worker-core.ts`
- `src/daemon/sync-worker-real-jobs.ts`
- `src/daemon/daemon-bootstrap.ts`
