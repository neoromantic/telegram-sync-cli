# Rate Limiting

> **Status:** Implemented

## Overview

telegram-sync-cli coordinates rate limits across the CLI and daemon per account, in the
account's own cache database (`accounts/<id>/cache.db`). All API calls are recorded and
FLOOD_WAITs are enforced before subsequent calls are made. A FLOOD_WAIT blocks only its own
account: a recorded one blocks its calls, and in the daemon one that mtcute sleeps through
inside a sync job holds only that account's job loop (see [Notes](#notes)).

Key behaviors:
- Track per-method call counts in 60-second windows (calendar minutes)
- Record FLOOD_WAITs and block calls until the wait expires
- Log each API call to `api_activity` (success/error, error code, duration) for status output
  and diagnostics; `tg status` counts the calls of the last 60 seconds from it

## Where It Lives

- `src/db/rate-limits.ts` — `RateLimitsService`
- `src/utils/telegram-rate-limits.ts` — `trackApiCall` (counts, times and logs one call) and
  the CLI wrapper
- `src/daemon/daemon-api-activity.ts` — a network middleware of the daemon's clients that
  counts and logs every request they send, on the same service

## Database Tables (each account's cache.db)

### rate_limits
Tracks call counts and flood waits per method.

Columns (see `docs/database-schema.md` for full definitions):
- `method`
- `window_start`
- `call_count`
- `last_call_at`
- `flood_wait_until`

### api_activity
Audits API calls (success/errors): every call of a CLI command, and every request of the
daemon: sync pages, contacts checks, dialog passes, the joined-communities check, `getMe` at
start, reconnect and health checks (`users.getUsers`), and mtcute's own requests such as
`updates.getDifference`. The daemon logs in a network middleware inside mtcute's flood waiter,
so a FLOOD_WAIT and the retry after it are two rows; a write that fails never fails the
request.

Columns:
- `timestamp` — when the call started, in ms
- `method`
- `success`
- `error_code` — Telegram's error code (`420` for a FLOOD_WAIT, `400`, …); `NULL` for an error
  that isn't Telegram's
- `response_ms` — how long the call took
- `context` — who called (`cli:send`, `cli:api`, …, `daemon`), or the error message of a
  failed call

0.8.0 and older wrote `timestamp` in seconds. The next prune (the daemon's, or `tg db vacuum`'s)
turns those rows into ms before it deletes old ones: a value below 10^11 can only be seconds,
the table holds a week of calls, and its timestamp index finds them, so this is one short
update rather than a background migration. Until then, `tg status` reads a seconds row as a
time in 1970 and leaves it out of the last minute: right after an upgrade, a CLI call that an
older tg made less than a minute before is missing from `api_calls_last_minute` until it is a
minute old anyway. The daemon prunes about every five minutes and when it stops, so a running
daemon on the new version converts them within minutes.

`tg status` reports `api_calls_last_minute` and `calls_by_method` from the rows of the last 60
seconds. The `rate_limits` windows are calendar minutes, so the current one holds only the
calls since the minute began.

### Retention

The daemon prunes both tables on a schedule, and `tg db vacuum` before it compacts
([daemon.md](daemon.md#cache-pruning)): `api_activity` rows after `cache.retention.apiActivity`
(7 days by default) and `rate_limits` windows after `cache.retention.rateLimits` (1 hour). A
window whose `flood_wait_until` is still in the future is kept, however old, so an active
FLOOD_WAIT is never forgotten, and so is the current 60-second window.

## Runtime Flow

1. Before an API call, the caller checks `RateLimitsService.isBlocked()`.
2. If blocked, the call returns a rate-limited result with wait time.
3. `trackApiCall()` (CLI) or the daemon's middleware increments the window count with
   `recordCall()` and, when the call ends, logs it to `api_activity` with `logActivity()`.
4. On FLOOD_WAIT errors, `setFloodWait()` records the block in `rate_limits`.

## CLI Integration

CLI commands wrap API calls using `wrapClientCallWithRateLimits(client, { accountId })`
(`getRateLimitsService(accountId)` opens that account's cache), so manual commands and the
daemon share the same rate-limit state for each account.

## Waiting Out FLOOD_WAITs

Both clients use mtcute's flood-waiter middleware, which sleeps and retries the request
instead of failing it:

- CLI commands wait up to 60 seconds.
- The daemon waits up to 5 minutes (for example during the dialog bootstrap on accounts
  with thousands of chats) and logs each wait; a daemon stop ends such a wait in the dialog
  pass or a sync job at once.

Longer waits fail the request and are recorded as described above. CLI commands report them
as `RATE_LIMITED` with `details: { method, wait_seconds }`, both on the failed request and on
later calls while the method is blocked.

File transfers (`tg media download`, `tg send --file`) go through the same wrapper, so every
`upload.getFile`, `upload.saveFilePart` and `upload.saveBigFilePart` call is recorded for the
account. They sleep through flood waits of up to 10 seconds, part by part and without a log
line; a longer wait ends the command with `RATE_LIMITED`. A download keeps its partial file, and
the next run after the wait resumes it ([media.md](media.md#download)).

## Daemon Sync Jobs

The daemon's sync jobs make one `messages.getHistory` call each, one job at a time per
account, shared by the account's three lanes (catch-up, first pages, history; see
[sync-strategy.md](sync-strategy.md#job-lanes)). How often a job starts is the account's pace
(see [Pacing](#pacing)). While a FLOOD_WAIT on `messages.getHistory` lasts, no lane of that
account runs a job; the other accounts' jobs go on. The job that hit it doesn't fail: it waits
out the FLOOD_WAIT as a pending job and uses no attempt, then runs again from its chat's cursor,
where the last page left it. Other errors retry with backoff (see
[sync-strategy.md](sync-strategy.md#retries)).

### Pacing

Each account's pace counts from the start of each job, so a slow page doesn't stretch it, and
the daemon starts a job as soon as it is due rather than on its next 1-second tick:

- **Calm.** With no first page or history page due, a job starts at most every 3 seconds
  (`sync.pacing.calmInterval`): catch-up and real-time traffic only.
- **History.** While a first page or a history page is due (the first sync, or the backfill of a
  chat `tg chats sync` turned on), the account starts at 0.7 calls per second. After each 30
  calls without a FLOOD_WAIT it speeds up by 0.05 calls per second, up to
  `sync.pacing.maxCallsPerSecond` (0.9 by default). Catch-up still gets its lane turns, so
  history going faster never delays it.
- **FLOOD_WAIT.** Any FLOOD_WAIT Telegram sends the account's client, on any method, halves
  the pace (never below the calm pace). The account starts no job until the wait is over and one
  interval at the new pace has passed; mtcute's flood waiter retries the call that hit it when
  the wait ends. The daemon logs the new pace.
- Once no history is due, the account goes back to the calm interval. The pace it learned is
  kept for the next backfill until the daemon restarts, which starts at 0.7 again.

Why these numbers: on a test account a closed loop of `messages.getHistory` calls (100 per
page, one public channel) got its first FLOOD_WAIT at 1 call per second after 70 to 100 calls,
with waits of 3 to 15 seconds that grew under pressure, and went on at 0.85 to 0.95 calls per
second through them; 0.7 calls per second ran 150 seconds with none. Two chats in parallel were
no faster, so an account runs one job at a time. Before this pacing, a first sync of about
10,000 pages made one call every ~4 seconds and spent ~92% of its time in the pause between
jobs.

`tg status` shows the pace in `progress.history`: `calls_per_second`, the `messages.getHistory`
calls of the last 5 minutes from `api_activity`, and `pacing`, the live daemon's
`{ mode, target_calls_per_second, flood_waits }` (see
[cli-commands.md](cli-commands.md#daemon--status--sql)).

## Notes

- Rate-limit tracking is per-method (e.g., `messages.getHistory`).
- CLI and daemon share each account's `cache.db`, so limits are coordinated per account.
- mtcute's flood waiter sleeps inside the call. Each account runs its own job loop, so a wait
  of up to 5 minutes inside one account's job holds only that account's jobs.
