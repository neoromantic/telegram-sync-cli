# Rate Limiting

> **Status:** Implemented

## Overview

telegram-sync-cli coordinates rate limits across the CLI and daemon per account, in the
account's own cache database (`accounts/<id>/cache.db`). All API calls are recorded and
FLOOD_WAITs are enforced before subsequent calls are made. A FLOOD_WAIT blocks only its own
account: a recorded one blocks its calls, and in the daemon one that mtcute sleeps through
inside a sync job holds only that account's job loop (see [Notes](#notes)).

Key behaviors:
- Track per-method call counts in rolling windows
- Record FLOOD_WAITs and block calls until the wait expires
- Log API activity (success/error) for status output and diagnostics

## Where It Lives

- `src/db/rate-limits.ts` — `RateLimitsService`
- `src/utils/telegram-rate-limits.ts` — CLI wrapper helpers
- `src/daemon/*` — daemon job execution uses the same service

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
Audits API calls (success/errors).

Columns:
- `timestamp`
- `method`
- `success`
- `error_code`
- `response_ms`
- `context`

## Runtime Flow

1. Before an API call, the caller checks `RateLimitsService.isBlocked()`.
2. If blocked, the call returns a rate-limited result with wait time.
3. On success, `recordCall()` increments the window count and activity log.
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

## Daemon Sync Jobs

The daemon's sync jobs make one `messages.getHistory` call each, at most one job every 3
seconds per account, shared by the account's three lanes (catch-up, first pages, history; see
[sync-strategy.md](sync-strategy.md#job-lanes)). While a FLOOD_WAIT on `messages.getHistory`
lasts, no lane of that account runs a job; the other accounts' jobs go on. The job that hit it doesn't fail: it waits out the FLOOD_WAIT as a
pending job and uses no attempt, then runs again from its chat's cursor, where the last page
left it. Other errors retry with backoff (see
[sync-strategy.md](sync-strategy.md#retries)).

## Notes

- Rate-limit tracking is per-method (e.g., `messages.getHistory`).
- CLI and daemon share each account's `cache.db`, so limits are coordinated per account.
- mtcute's flood waiter sleeps inside the call. Each account runs its own job loop, so a wait
  of up to 5 minutes inside one account's job holds only that account's jobs.
