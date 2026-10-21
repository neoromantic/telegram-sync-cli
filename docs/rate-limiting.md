# Rate Limiting

> **Status:** Implemented

## Overview

telegram-sync-cli coordinates rate limits across the CLI and daemon via a shared
SQLite cache database. All API calls are recorded and FLOOD_WAITs are enforced
before subsequent calls are made.

Key behaviors:
- Track per-method call counts in rolling windows
- Record FLOOD_WAITs and block calls until the wait expires
- Log API activity (success/error) for status output and diagnostics

## Where It Lives

- `src/db/rate-limits.ts` — `RateLimitsService`
- `src/utils/telegram-rate-limits.ts` — CLI wrapper helpers
- `src/daemon/*` — daemon job execution uses the same service

## Database Tables (cache.db)

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

CLI commands wrap API calls using `wrapClientCallWithRateLimits()` so manual
commands and the daemon share the same rate-limit state.

## Waiting Out FLOOD_WAITs

Both clients use mtcute's flood-waiter middleware, which sleeps and retries the request
instead of failing it:

- CLI commands wait up to 60 seconds.
- The daemon waits up to 5 minutes (for example during the dialog bootstrap on accounts
  with thousands of chats) and logs each wait.

Longer waits fail the request and are recorded as described above. CLI commands report them
as `RATE_LIMITED` with `details: { method, wait_seconds }`, both on the failed request and on
later calls while the method is blocked.

## Daemon Sync Jobs

The daemon's sync jobs make one `messages.getHistory` call each, at most one job every 3
seconds, shared by its three lanes (catch-up, first pages, history; see
[sync-strategy.md](sync-strategy.md#job-lanes)). While a FLOOD_WAIT on `messages.getHistory`
lasts, no lane runs a job. The job that hit it fails; its chat's cursor stays where the last
page left it, and the next refresh after the wait queues the chat again. Retries with backoff
for jobs that keep failing are tracked in
[#9](https://github.com/neoromantic/telegram-sync-cli/issues/9).

## Notes

- Rate-limit tracking is per-method (e.g., `messages.getHistory`).
- CLI and daemon share the same `cache.db`, so limits are coordinated.
