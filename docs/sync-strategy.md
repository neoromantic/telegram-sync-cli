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
- `channel`, `community` → disabled, **Low**. A community is a collection of linked chats; the
  chats linked to it are ordinary supergroups and channels and get their own policy. A
  community has no messages of its own, so `tg chats sync` refuses to turn one on.

### Turning a chat on or off

`tg chats sync <chat>` turns sync on for any chat but a community, `--off` turns it off and `--auto` goes back
to the policy. The choice is stored in `chat_sync_state.sync_mode` (`auto`, `on`, `off`), and
the dialog pass and live updates never overwrite it: an upsert keeps `sync_enabled` at 1 for
`on` and 0 for `off`, and `sync_priority` at High for `on`, while the chat type and member
count still update. A chat turned on gets the High tier and its first page at P0.

Running `tg chats sync <chat>` again, even with the same mode, deletes the chat's failed jobs,
so the daemon retries them at its next refresh (see [Retries](#retries)). To retry without
changing the mode, pass the current one: `--auto` for a chat that follows the policy, no flag
for one turned on.

The mode and the policy control catch-up, first pages and history only. While the daemon runs,
it caches messages that arrive live in every chat, including one that is off.

Telegram often leaves the member count out of a supergroup's dialog, and such a group may have
thousands of members, so a group without a count is treated as large. The dialog pass keeps the
last known count when a dialog omits it, so a chat doesn't flip on or off between starts. A
live message in a chat the daemon hasn't seen yet creates its state from the message's chat:
basic groups always carry their member count, supergroups often don't. It also caches the chat
in `chats_cache` if it has no row there, so the first page can reach it before the next dialog
pass (see [real-time.md](real-time.md)).

## Data Model

Core tables (see `docs/database-schema.md` for full schema):

- `chat_sync_state` — per-chat cursors + priority + progress
- `sync_jobs` — persistent job queue
- `messages_cache` — message storage
- `history_ranges` — the message ID ranges each cached page covers, so reads can tell a gap from
  a run of messages (see [caching.md](caching.md#chat-history))

## Job Types

Implemented in `SyncJobType`:

- `forward_catchup` — fetch the next page of messages above `forward_cursor`
- `initial_load` — the first page of a chat without a forward cursor: its newest 100 messages
- `backward_history` — backfill older history
- `full_sync` — full history job (used sparingly)

Job status values:
- `pending`, `running`, `completed`, `failed`

A pending job runs once it is due: `next_run_at` is 0 for a new job and later for a job waiting
for a retry.

### Retries

A job that fails is pending again after a backoff, with the same ID, in its lane at its chat's
priority at that time (a chat turned on while its first page ran gets the retry at P0):

- **Backoff**: the job waits 1, 2, 4 and 8 minutes after its first four failures; `attempts`
  counts them and `error_message` holds the last error. The fifth failure marks it `failed`.
  While a lane's jobs are all waiting, its slots go to the other lanes.
- **FLOOD_WAIT**: a delay, not a failure. The job waits out the FLOOD_WAIT (at least a second,
  so `FLOOD_WAIT_0` too) and uses no attempt; every lane of that account pauses for the same
  wait; other accounts go on.
- **Permanent errors** fail the job at once: an RPC error 400, 403 or 404, `CHANNEL_PRIVATE`
  with any code, a chat without an InputPeer, or an unknown job type. 401 and 406 are account
  errors that the connection health check handles, so they retry like network errors, timeouts
  and database errors.
- **Failed jobs**: a `failed` row blocks its chat's jobs of that type, so no refresh queues the
  chat for it again. The daemon deletes failed rows after `cache.retention.failedJobs` (24 hours by
  default; see [configuration.md](configuration.md#configuration-file)), and all of them on start;
  `tg chats sync <chat>` deletes the chat's failed rows at once, in any mode, so pass the
  chat's current mode to keep it (`tg status` prints the command). The next refresh then
  queues the chat again.
- **A chat turned off** while its job runs: if the job fails or hits a FLOOD_WAIT, it is
  dropped, not retried or kept as `failed`, whatever the error and attempt.
- **A crash** doesn't count as an attempt: on start, the jobs it left running are pending again.
- **A stop** doesn't count either: a job whose request the daemon stop cut short, a FLOOD_WAIT
  it was waiting out included, is pending as it was and runs again on the next start (a
  catch-up job is queued again if its chat is still behind).

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
  delay. A page that fails leaves the cursor where it was, and the job runs again from it
  after its backoff or FLOOD_WAIT (see [Retries](#retries)).
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

A full page leaves the top alone and queues the next page. A page that fails or hits a
FLOOD_WAIT leaves it alone too, and the same job runs again once it is due.

Each account's dialog pass covers its own cache only, on start and after every reconnect. If
the pass listed all the account's dialogs, an enabled chat with a cursor in that account's
cache that the pass didn't list (left, deleted or migrated) is marked caught up
(`top_message_id = forward_cursor`). After a pass that fails part-way those chats get
`top_message_id = NULL`, so each gets one checking page. Another account's failed pass doesn't
change that, and an account that didn't connect keeps its sync state as it is.

A chat turned on with `tg chats sync` that no pass listed gets `top_message_id = NULL` after
every pass, complete or not, so it gets one checking page on start and after each reconnect.
It may be a channel you haven't joined: no dialog list shows it and no live update reaches it,
so those checks are the only way its new messages arrive.

Trade-off: live updates don't move the cursor, so an active chat's cursor trails its live
messages for the whole run. The first catch-up after a restart or reconnect fetches them again,
about one `getHistory` call per 100 live messages per chat. The upsert doesn't duplicate them,
and only messages that weren't cached yet count towards `synced_messages`.

mtcute's `catchUp` option stays off: forward catch-up already covers missed messages, and
`getDifference` can't replay a long gap anyway (`differenceTooLong`).

### History

Each `backward_history` job fetches the 100 messages below `backward_cursor`
(`offset_id = backward_cursor`), caches them and moves the cursor to the oldest one. Empty
messages count for the cursor, so a page of deleted messages still moves it, and a page without
any message ID ends the history. Only messages that weren't cached yet count towards
`synced_messages`. A page that isn't full or reaches message 1 marks history complete.

Older versions could leave a chat with a forward cursor but no backward cursor (0.1.4's
catch-up, and live updates before it, set only the forward one), or with a backward cursor
above the forward one. Such a chat's history starts just above the forward cursor
(`offset_id = forward_cursor + 1`), so every message below it is fetched, not only those below
the oldest cached message.

A chat without either cursor starts at the newest page, not at the oldest cached message:
`tg send` caches what it sends and `tg messages list` and `get` cache any page of a chat, all
without moving the cursors, so the oldest cached message says nothing about how far history got.

### History ranges

Every page a sync job caches records the message ID range it covers in `history_ranges`, as the
pages `tg messages list` and `get` fetch do: a first page from its oldest to its newest message,
a catch-up page from just above its cursor, a history page up to its cursor, and a page that
reaches the first message down to 1. Touching ranges merge, so a chat synced without gaps ends
up with one range. Live updates record none. `tg messages list` and `get` read from the cache
only inside a range (see [caching.md](caching.md#chat-history)), so the newest messages that
arrived live come from Telegram until the next catch-up covers them.

### Scheduling

0. **Dialog pass** on start, one per connected account: fills `chats_cache` and updates
   `chat_sync_state` (type, member count, policy, `top_message_id`). One more request caches
   the joined communities in `chats_cache`; if it fails, the daemon logs a warning and the
   pass still counts as complete
1. The scheduler recovers jobs a crash left running, deletes failed jobs (a restart retries
   them), drops pending catch-ups (older versions left one for every chat) and queues the work
   that is due: catch-up for chats that are behind, first pages and history
2. Every 30 seconds, and after each reconnect's dialog pass, it queues due work again, such as
   chats first seen live
3. The worker runs jobs with `messages.getHistory` and updates cursors and counters

The scheduler uses the database as the single source of truth. There is **no in-memory priority queue**.

### Archived chats

The dialog pass lists archived dialogs too. They update `chats_cache`, so sync jobs can build an
InputPeer for them, and the sync state of chats that already have one. The pass creates no
state row for an archived chat. An archived chat starts syncing when a message arrives in it
live, which creates its state like in any other chat (the update doesn't say whether the chat
is archived), or when `tg chats sync` turns it on.

## Job lanes

Each account has its own queue, scheduler and job loop: it runs at most one job at a time,
starts the next 3 seconds after the last one ended, and doesn't wait for other accounts, so its
jobs share one `messages.getHistory` budget and one account's FLOOD_WAIT or slow page doesn't
hold another's. An account's jobs are split into three lanes:

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
- A FLOOD_WAIT on `messages.getHistory` blocks every lane of that account until it expires;
  the job that hit it waits it out without using an attempt and runs again from its chat's
  cursor (see [Retries](#retries)).

## Notes

- Catchup and realtime run concurrently; realtime handlers do not wait for catchup to complete.
- Daemon bootstraps dialogs on startup to seed `chats_cache` + `chat_sync_state`, and runs the
  same pass in the background after each reconnect.
- The daemon checks each account's contact list on start, after each reconnect and every
  peer TTL with Telegram's hash, so an unchanged list costs one tiny reply (see
  [daemon.md](daemon.md#contacts-sync)). `tg contacts list --fresh` still fetches it at once.

## Implementation References

- `src/db/sync-schema.ts`
- `src/db/sync-jobs.ts`
- `src/db/chat-sync-state.ts`
- `src/daemon/scheduler.ts`
- `src/daemon/sync-retry.ts`
- `src/daemon/sync-worker-core.ts`
- `src/daemon/sync-worker-real-jobs.ts`
- `src/daemon/daemon-bootstrap.ts`
