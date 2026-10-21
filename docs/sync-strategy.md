# Sync Strategy

> **Status: Implemented (v0.1.0)** — current sync behavior implemented in `src/daemon/*` and `src/db/*`.

## Overview

The daemon synchronizes message history using a **dual cursor** system and a **persistent job queue**:

- **Forward cursor** marks how far forward the cache is complete: every message up to it is
  cached. Only sync jobs move it, never live updates.
- **Newest message ID** (`top_message_id`) tells whether the forward cursor is behind
- **Backward cursor** tracks how far history backfill has progressed
- **sync_jobs** provides resumable work in three lanes that take turns

## Dual Cursor System

Each chat maintains two independent cursors:

```
Timeline: [oldest] ---- [backward_cursor] ---- [forward_cursor] ---- [newest]
           ^                                           ^
     History backfill                             Forward catch-up
```

Stored in `chat_sync_state`:
- `forward_cursor` — every message up to this ID is cached; forward catch-up continues from here
- `top_message_id` — the newest message ID Telegram reported; `NULL` means unknown and counts
  as behind
- `backward_cursor` — oldest synced message ID
- `history_complete` — reached beginning of history

## Sync Priorities

### Priority Tiers

| Priority | Category | Sync Behavior |
|----------|----------|---------------|
| **P1** | DMs + small groups (<20 members) | Full history sync |
| **P2** | Medium groups (20–100 members) | Newest 100 messages, then history after the P1 chats |
| **P3** | Groups of unknown size, large groups (>100) & channels | On request only (`tg chats sync`) |

Live updates don't go through the queue: they are cached as they arrive. A chat's tier
(`sync_priority`) is also the priority of its jobs inside each lane (see
[Job lanes](#job-lanes)). P0 is only for the first page of a chat turned on with
`tg chats sync`. P4 is no longer used; older versions queued catch-up at P0 and history at P4.

### Policy (Current)

Implemented in `determineSyncPolicy`:

- `private` → enabled, **High**
- `group/supergroup`:
  - unknown member count → disabled, **Low**
  - `< 20` → enabled, **High**
  - `20–100` → enabled, **Medium**
  - `> 100` → disabled, **Low**
- `channel` → disabled, **Low**

### Turning a chat on or off

`tg chats sync <chat>` turns sync on for any chat, `--off` turns it off and `--auto` goes back
to the policy. The choice is stored in `chat_sync_state.sync_mode` (`auto`, `on`, `off`), and
the dialog pass and live updates never overwrite it: an upsert keeps `sync_enabled` at 1 for
`on` and 0 for `off`, and `sync_priority` at High for `on`, while the chat type and member
count still update. A chat turned on gets the High tier and its first page at P0.

Telegram often leaves the member count out of a supergroup's dialog, and such a group may have
thousands of members, so a group without a count is treated as large. The dialog pass keeps the
last known count when a dialog omits it, so a chat doesn't flip on or off between starts. A
live message in a chat the daemon hasn't seen yet creates its state from the message's chat:
basic groups always carry their member count, supergroups often don't.

## Data Model

Core tables (see `docs/database-schema.md` for full schema):

- `chat_sync_state` — per-chat cursors + priority + progress
- `sync_jobs` — persistent job queue
- `messages_cache` — message storage

## Job Types

Implemented in `SyncJobType`:

- `forward_catchup` — fetch the next page of messages above `forward_cursor`
- `initial_load` — the first page of a chat without a forward cursor: its newest 100 messages
- `backward_history` — backfill older history
- `full_sync` — full history job (used sparingly)

Job status values:
- `pending`, `running`, `completed`, `failed`

## Sync Flow (Current)

### Real-time

- Handlers listen to mtcute events immediately
- New messages are upserted into `messages_cache`. They don't move `forward_cursor`: messages
  that arrived while the daemon was stopped may sit between the cursor and a live message.

### First page

Every enabled chat without a `forward_cursor` gets an `initial_load` job, even if live updates
already cached some of its messages. The job fetches the newest page, sets `forward_cursor` to
its newest message and `backward_cursor` to its oldest (empty messages count for both), and
marks history complete if the page reached the start of the chat. Only messages that weren't
cached yet count towards `synced_messages`. An empty chat gets both cursors at `0`, so its first
message is caught up from the start like any other gap. A chat that already has a forward
cursor never gets a first page again: moving the cursor to the newest message could skip
messages below it.

### Forward catch-up

Each `forward_catchup` job makes one `messages.getHistory` call:

- **With a cursor** (`0` included), it fetches the oldest 100 messages above it
  (`offset_id = cursor + 1`, `add_offset = -100`, `min_id = cursor`), caches them and moves the
  cursor to the newest one. A full page means there may be more, so the scheduler queues the
  next page right away. One call per job keeps paging under the rate limits and the inter-job
  delay. If a page fails (for example on a FLOOD_WAIT), the next catch-up resumes from the
  cursor.
- **Without a cursor** (a chat the daemon hasn't synced yet), it fetches the newest page and
  sets the cursor to its newest message. Older history is the backward job's.

So after a restart, catch-up pages from the stored cursor up to the newest message, and every
message that arrived while the daemon was stopped ends up in the cache, even if live messages
arrive first.

#### When catch-up runs

There is no periodic polling. A chat is due for catch-up when it is enabled, has a forward
cursor, and its `top_message_id` is `NULL` or above the cursor. A chat that is caught up costs
no calls. What writes `top_message_id`:

- **The dialog pass**, on start and after every reconnect, raises it to each listed dialog's
  newest message (`topMessage`) and never lowers it. A dialog without one leaves it alone.
- **The first page** raises it to at least the page's newest message.
- **A catch-up page that isn't full** reached the newest message, so the same write that moves
  the cursor sets `top_message_id` to the new cursor. If a dialog pass raised the top while the
  page was in flight, the top stays and the chat stays due. A newest message that was deleted
  settles after one call.
- **Live updates never write it**, just as they never move the cursor.

A full page leaves the top alone and queues the next page. A failed or FLOOD_WAITed page also
leaves it alone, so the next refresh queues the chat again once calls are allowed.

On start, after the dialog passes: if every account connected and every pass listed all its
dialogs, an enabled chat with a cursor that no pass listed (left, deleted or migrated) is
marked caught up (`top_message_id = forward_cursor`). Otherwise those chats get
`top_message_id = NULL`, so each gets one checking page. After a reconnect, a pass that fails
part-way does the same for the chats it didn't list; all accounts share one cache (#17), so
that is a safe superset. A complete reconnect pass covers one account and marks nothing.

Trade-off: live updates don't move the cursor, so an active chat's cursor trails its live
messages for the whole run. The first catch-up after a restart or reconnect fetches them again,
about one `getHistory` call per 100 live messages per chat. The upsert doesn't duplicate them,
and only messages that weren't cached yet count towards `synced_messages`.

mtcute's `catchUp` option stays off: forward catch-up already covers missed messages, and
`getDifference` can't replay a long gap anyway (`differenceTooLong`).

### Scheduling

0. **Dialog pass** on start, one per connected account: fills `chats_cache` and updates
   `chat_sync_state` (type, member count, policy, `top_message_id`)
1. The scheduler recovers jobs a crash left running, drops pending catch-ups (older versions
   left one for every chat) and queues the work that is due: catch-up for chats that are
   behind, first pages and history
2. Every 30 seconds, and after each reconnect's dialog pass, it queues due work again: chats
   first seen live, pages that failed
3. The worker runs jobs with `messages.getHistory` and updates cursors and counters

The scheduler uses the database as the single source of truth. There is **no in-memory priority queue**.

### Archived chats

The dialog pass lists archived dialogs too. They update `chats_cache`, so sync jobs can build an
InputPeer for them, and the sync state of chats that already have one. An archived chat without
a state row doesn't get one: archived chats don't start syncing on their own.

## Job lanes

The daemon runs at most one job every 3 seconds, and all jobs share one `messages.getHistory`
budget. Jobs are split into three lanes:

| Lane | Job types |
|------|-----------|
| catch-up | `forward_catchup` |
| first page | `initial_load` |
| history | `backward_history`, `full_sync` |

The lanes take turns in a fixed cycle of four slots: catch-up, first page, catch-up, history.
When every lane has work, catch-up gets half the jobs and first pages and history a quarter
each. A slot whose lane is empty goes to the first lane with work, in the order catch-up, first
page, history, so no slot is wasted. A slot is used only when a job runs: a tick without a job
or without a worker that may call the API moves nothing. The position in the cycle is kept in
memory and starts over on restart.

Inside a lane, jobs run by priority (the chat's tier: small chats before medium groups), then
by age, then by ID. After a first page with history left, the chat's history job is queued
right away. A catch-up or history page that is full queues the next page of the same chat.

The queue methods create no job for a chat that is disabled or has no state row, so a chat
whose sync was turned off stops after the job that is running. On start the scheduler also
drops pending jobs of such chats and moves every other pending job to its chat's tier.

## Batch Size

Sync jobs use a default batch size of **100 messages** (configurable in worker config).

## Rate Limiting

Rate limits are tracked per API method:
- `rate_limits` table stores call count + flood wait
- Workers and CLI calls share the same rate-limit service
- A FLOOD_WAIT on `messages.getHistory` blocks every lane until it expires; the job that hit it
  fails and its chat is queued again at the next refresh, from its cursor. Retries with
  backoff are [#9](https://github.com/neoromantic/telegram-sync-cli/issues/9).

## Notes

- Catchup and realtime run concurrently; realtime handlers do not wait for catchup to complete.
- Daemon bootstraps dialogs on startup to seed `chats_cache` + `chat_sync_state`, and runs the
  same pass in the background after each reconnect.
- Contact sync remains **CLI-driven**; the daemon does not refresh contacts.

## Implementation References

- `src/db/sync-schema.ts`
- `src/db/sync-jobs.ts`
- `src/db/chat-sync-state.ts`
- `src/daemon/scheduler.ts`
- `src/daemon/sync-worker-core.ts`
- `src/daemon/sync-worker-real-jobs.ts`
- `src/daemon/daemon-bootstrap.ts`
