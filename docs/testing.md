# Testing Guide

This document covers the implemented testing infrastructure for telegram-sync-cli.

## Overview

| Type | Location | Purpose |
|------|----------|---------|
| Unit Tests | `src/__tests__/*.test.ts` | Fast, isolated component tests |
| E2E Tests | `src/__e2e__/*.e2e.test.ts` | CLI execution + exit code behavior |
| Integration Tests | `src/__integration__/*.integration.test.ts` | Real Telegram API validation (optional) |

> For current coverage, run `bun run test:coverage`.

## Running Tests

```bash
# Unit tests only
bun run test

# E2E tests only
bun run test:e2e

# Integration tests only (real API, optional)
bun run test:integration

# All tests (unit + E2E)
bun run test:all

# With coverage report
bun run test:coverage

# Watch mode
bun test --watch

# Specific test file
bun test src/__tests__/auth.test.ts
```

## Unit Tests

Unit tests run without network access using mocked dependencies.

`test-setup.ts`, preloaded for every `bun test` run, points `TELEGRAM_SYNC_CLI_DATA_DIR` at
`.tmp/test-data-<pid>` even if the shell or `.env` sets it, so tests that use the file-backed
cache database never touch a real data dir. It also sets `TELEGRAM_SYNC_CLI_TELEMETRY=0`, so no
test and no CLI a test spawns sends usage stats; `src/__e2e__/telemetry.e2e.test.ts` sets it to
`debug`, which prints each event to stderr instead of sending it.

The test scripts pass `--isolate`, so each file gets a fresh module registry. `mock.module()`
replaces a module for the whole process and `mock.restore()` doesn't undo it, so without
isolation a module mock would leak into every file that runs after it, and the file order
differs between macOS and Linux.

### Test Patterns

**In-memory database**: Each test gets an isolated SQLite instance.

```typescript
import { createTestDatabase } from '../db'

const { accountsDb, db } = createTestDatabase()
```

**Dependency injection**: Services use interfaces for testability.

```typescript
const deps: AuthDependencies = {
  accountsDb: createTestDatabase().accountsDb,
  createClient: mock(() => mockClient),
}
```

### Core Unit Test Files

- `auth.test.ts` — authentication flows (phone, QR, logout); a login makes its account the
  only active one and writes it to `activeAccount` when `config.json` sets the key (never
  creating the file), and a failed one, or one whose `config.json` can't be written, leaves
  the active account alone
- `db.test.ts` — database operations
- `output.test.ts` — JSON/pretty/quiet output formatting
- `telegram.test.ts` — Telegram service layer
- `sync-jobs.test.ts` — sync job lifecycle, retries and counts
- `sync-scheduler.test.ts` — what the scheduler queues and the lane turns
- `sync-retry.test.ts` — the retry backoff and which errors are permanent
- `update-handlers.test.ts` — daemon update handlers
- `daemon-restart-gap.test.ts` — messages that arrive while the daemon is stopped are all
  cached after a restart
- `sync-fair-share.test.ts` — on 500 chats, history and first pages make progress next to
  catch-up, chats that are caught up cost no calls, and a FLOOD_WAIT stops every lane and
  delays the job that hit it without failing it
- `sync-failing-chats.test.ts` — a chat whose pages keep failing retries after 1, 2, 4 and 8
  minutes and gives up after five attempts, a permanent error fails at once, and neither is
  queued again on every refresh (fake clock)

The last three run the real scheduler, sync worker and job loop against a fake
`messages.getHistory` (`helpers/fake-history.ts`; `createMultiChatHistory` routes on the
request's peer).

- `telegram-peer-ids.test.ts` — marked peer IDs, cross-checked against mtcute's
  `getMarkedPeerId` and `parseMarkedPeerId`
- `peer-id-migration.test.ts` — the move of a 0.2.0 cache to marked IDs: rows re-keyed from
  `raw_json` or their type, duplicates merged, group and channel senders marked, senders filled
  in for messages without `fromId`, a failure rolled back and retried, a second run that changes
  nothing
- `cache-layout.test.ts` — the move of the shared cache of 0.3 and older on temp data dirs:
  adopt, set aside or delete for 0, 1 or 2 accounts with or without a per-account cache, rows
  still in the WAL, an earlier `shared-cache.db` never overwritten, a held file that blocks
  adopting but only defers setting aside
- `cache-meta.test.ts` — the owner stamp of an account's cache
- `cache-db-lock.test.ts` — several processes opening, migrating and moving caches at once
- `account-selector.test.ts` — `resolveAccount`: `--account`, the active account, the only one,
  and the errors
- `args.test.ts` — which `tg api` flags take the next argument as their value: a method
  argument after the method, followed by a value or a negative number; not `--name=value`,
  `--no-name`, `--account`/`-a`, `--json`/`-j` or `-r`, a flag before the method or followed
  by another option, a value such as `-hi`, or anything after `--`
- `daemon-scheduler.test.ts`, `daemon-bootstrap.test.ts`, `daemon-accounts.connect.test.ts`,
  `daemon-start-caches.test.ts` — the daemon with two accounts: each job runs on its own
  account's client, each account runs its own jobs on its own 3 s delay and one account's
  FLOOD_WAIT doesn't hold another's, dialogs, live messages and deletes land in the
  receiving account's cache, and an account whose cache doesn't open is left out
- `daemon-loop.test.ts` — the daemon's main loop: per-account job loops, a stop ends the tick
  wait at once, and a health check runs beside a sync job while a reconnect waits for it
- `daemon-stop.test.ts` — the daemon's start and stop with fake clients: a stop during a
  FLOOD_WAIT in the startup dialog pass or a sync job ends the wait at once, and the job stays
  pending (`helpers/flood-wait.ts` waits like mtcute's flood waiter until the request's
  `abortSignal` aborts)
- `daemon-platform.test.ts` — the daemon's mtcute platform, on a real client and a temp
  session file in a child process (`helpers/session-exit-child.ts`, no network): mtcute adds
  no signal listeners, a session write after SIGTERM is saved when the client closes, and an
  exit without closing it still saves the queued writes

Daemon tests give each account its own in-memory cache with `addAccountRuntime(ctx, id)`
(`helpers/daemon-runtime.ts`). Tests that `mock.module('../db', …)` use `mockDbModule`
(`helpers/db-mock.ts`), which maps each account ID to its cache. A test that writes a SQLite
file another process must find closed (the shared cache that tg moves) seeds it with
`seedInChild(path, seeder)` (`helpers/seed-in-child.ts`, seeders in `helpers/seeders.ts`):
bun:sqlite keeps a file open after `close()` while prepared statements remain.

### Peer ID fixtures

Seed `chats_cache` the way `tg` writes it: through `dialogToCacheInput(fakeDialog(…))`
(`helpers/fake-dialogs.ts`), `rawChatToCacheInput` or `userToPrivateChatCacheInput`, and
messages through `parseRawMessage` of a raw TL message, or with valid marked IDs. A hand-made
row under a bare group or channel ID is the 0.2.0 format, which the next `initSyncSchema`
migrates.

- `helpers/legacy-cache.ts` builds a cache as 0.2.0 left it (`initLegacySchema`,
  `seedLegacyCache`), for migration tests.
- `helpers/peer-id-invariants.ts` has `assertPeerIdInvariants(db)`: every `chats_cache` and
  `chat_sync_state` ID fits its type, every chat ID in the other tables parses with mtcute, and
  none of them is a positive ID that `chats_cache` or `chat_sync_state` knows as a group or
  channel. The bootstrap, update handler, send cache and e2e tests run it at the end.

### Snapshot Tests

Snapshot tests lock down formatted output to catch regressions.

- Helpers live in `src/__tests__/helpers/snapshots.ts`
- Snapshots use Bun's `toMatchSnapshot` / `toMatchInlineSnapshot`
- Update snapshots with `bun test -u`

```typescript
import { snapshotLines } from './helpers/snapshots'

setOutputFormat('json')
success({ message: 'Snapshot test', count: 2 })
expect(snapshotLines(logs)).toMatchInlineSnapshot(`
"{
  "success": true,
  "data": {
    "message": "Snapshot test",
    "count": 2
  }
}"
`)
```

## E2E Tests

E2E tests execute the CLI binary via `Bun.spawn` to verify actual command behavior.

### Test Isolation

Tests use `TELEGRAM_SYNC_CLI_DATA_DIR` to create isolated environments:

- Unique temp directory per test
- Fresh SQLite database
- No interference with production data (`~/.telegram-sync-cli/`)
- Automatic cleanup after each test

### E2E Files

- `help.e2e.test.ts` — `--help`, subcommand help, invalid commands
- `exit-codes.e2e.test.ts` — exit codes for common failure modes
- `format.e2e.test.ts` — `--format` json/pretty/quiet behavior
- `accounts.e2e.test.ts` — `list`, `switch`, `remove`, `info`
- `config.e2e.test.ts` — `tg config path`, `get` and `set`; `tg config` repairs an invalid
  `config.json` and `tg skill` runs with one after any format flag (`-q`, `-f <format>`), as
  `tg daemon start` does with and without its `--quiet`; an unreadable one fails other commands
  with `GENERAL_ERROR` (empty stderr under `-q`)
- `user.e2e.test.ts` — `me`, `user` lookups
- `commands.e2e.test.ts` — command coverage smoke tests
- `daemon.e2e.test.ts` — daemon start/stop/status
- `sql.e2e.test.ts` — `tg sql` queries through the real argument parser
- `messages.e2e.test.ts` — `tg messages search`, `list` and `get` on a seeded cache, without
  credentials; chat titles and IDs in search results, and the first run on a 0.2.0 cache
- `messages-search-query.e2e.test.ts` — the query rules of `tg messages search` (plain words,
  FTS5 syntax, `--phrase`, query errors), `--since`/`--until`, `--sort` and `--count`
- `chats-sync.e2e.test.ts` — `tg chats sync` against a seeded cache, without credentials
- `api.e2e.test.ts` — `tg api` with a fake Telegram client (`helpers/fake-client-cli.ts`, run
  as runCli's `entry`), which keeps the process alive even after it is closed, as a connected
  mtcute client might: with and without `--raw` and on a failed call, the command prints its
  output, closes the client and exits the process itself
- `status.e2e.test.ts` — `tg status` counts and lists running, pending, retrying and failed
  sync jobs from a seeded cache, in JSON and pretty output, without credentials; the retry
  commands it prints delete the failed jobs and keep each chat's mode; it shows the daemon's
  version, a restart hint for a running daemon of another or unrecorded version and a "use the
  newer tg" hint for a newer one; no hint for the same version, a stopped daemon (one that died,
  stopped cleanly or never ran) or one still starting
- `multi-account.e2e.test.ts` — two accounts, each with its own cache and a message with the
  same ID: every cache command returns only the selected account's rows, `tg accounts switch`
  changes which and lasts across later commands with and without `activeAccount` in
  `config.json` (and under `-q`), `tg chats sync` writes only its account's file, the errors for
  zero, one or several accounts, `tg status` totals (calls by method summed, flood waits and the
  overall top 5 sample chats with their `account_id`), and no root `cache.db` is ever created
- `cache-layout.e2e.test.ts` — the first run after an upgrade from 0.3 or older: a shared cache
  adopted (a 0.2.0 one migrated too), set aside with one notice, deleted when empty,
  `CACHE_UNAVAILABLE` while an older tg holds it (and no account added or removed), and the
  owner check
- `api-args.e2e.test.ts` — the request `tg api` builds: each test records a replay fixture
  for an exact request with a stub client, then `tg api` in replay mode finds it only if it
  sends that request with no extra keys; `--username myuser`, `--username=myuser` and `--json`
  build the same call, as do flags with no value, dotted names and negative numbers (`-10`,
  `-1.5`) in either form, with `--account`/`-a` before or after the method; tg's own options
  (`-v`, `--verbose`, `-f json`, `--format json`, `-q`, `--quiet`) stay out of the request

### E2E Helpers

**CLI execution** (`src/__e2e__/helpers/cli.ts`):

```typescript
// Run CLI and capture output
const result = await runCli(['accounts', 'list'])
// result.stdout, result.stderr, result.exitCode, result.json
```

**Test environment** (`src/__e2e__/helpers/setup.ts`):

```typescript
const env = createTestEnvironment('my-test')
env.initDatabase()
env.seedAccounts([{ phone: '+15550000000', is_active: true }])
// accounts/1/cache.db with the current schema; open until cleanup()
const cacheDb = env.openCacheDb(1) // env.cachePath(1) is its path

await runCli(['chats', 'list'], env.getCliOptions())

env.cleanup()
```

Seed an account before running a cache command: with no account it fails with
`AUTH_REQUIRED`.

## Integration Tests (Real API)

`src/__integration__/` is a live smoke suite: it runs the CLI the way a user would, against the
real Telegram API. It is skipped unless the variables below are set, and it never runs in CI.

| Test | What it proves |
|------|----------------|
| auth status and me | the session is valid; `me --fresh` writes the profile and `me` reads it back from the cache |
| chats and contacts | dialogs and contacts come from the API, then `chats list` serves them from the cache |
| send to Saved Messages | `send --to me` delivers a message; `tg api messages.getMessages` reads it back |
| send caches for search | with no daemon running, `messages search` finds a message right after `send --to me`, under the own user ID |
| messages list and get | after two sends whose cache rows are dropped, `messages list --chat me --fresh` returns them newest first from the API under the own user ID; the next read comes from the cache with equal items, `messages search` finds them, `--after` pages forward, and `messages get --context 1` reads one in context from the API, then from the cache; a cache-first `get --context 2` returns it with the newer message and up to two older ones |
| daemon | the daemon connects, starts real-time updates, bootstraps dialogs (waiting out FLOOD_WAITs) into `accounts/<id>/cache.db` (no root `cache.db`), syncs messages into the cache, shows up in `tg status` with its own version and stops cleanly with `tg daemon stop` while sync jobs are queued: exit code 0, one "Received SIGTERM", no updates-loop error, closed-database error or failed close, no job left running and no `DaemonStopError` or `AbortError` in the output |

Each test copies the session into its own temp data dir. Messages go only to the account's
Saved Messages and are deleted after each test. A run takes about a minute.

### Environment Variables

- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`
- `TELEGRAM_TEST_ACCOUNT`: the account's phone number in international format
- `TELEGRAM_TEST_SESSION_PATH` (or `TELEGRAM_TEST_SESSION`): path to a `session_<id>.db`

Log in once into a data dir used only for tests, so the suite never shares a session with
your own daemon:

```bash
TELEGRAM_SYNC_CLI_DATA_DIR=/path/to/tg-test-data tg auth login --phone=+15550000000
# then: TELEGRAM_TEST_SESSION_PATH=/path/to/tg-test-data/session_1.db
```

Bun loads `.env`, so the variables can live there (see `.env.example`).

### Run Integration Tests

```bash
bun run test:integration
```

### Record/Replay Fixtures (Offline Mode)

To run integration tests deterministically without network access, you can
record and replay API fixtures.

```bash
# Record fixtures
TELEGRAM_API_RECORD=1 bun run test:integration

# Replay fixtures (no network)
TELEGRAM_API_REPLAY=1 bun run test:integration
```

By default fixtures are stored under:
`$TELEGRAM_SYNC_CLI_DATA_DIR/fixtures/telegram`. Override with
`TELEGRAM_API_FIXTURES_DIR`.

## CI/CD

`.github/workflows/ci.yml` runs on every push to `main`, on pull requests and weekly:

- `build` — devkit's reusable `ci-bun.yml`: `bun run check`, `bun run build`, `bun run test`,
  `bun run test:e2e`.
- `hygiene` — devkit's `hygiene.yml`: actionlint, zizmor, gitleaks and a privacy scan of added
  lines.
- `pack` — compiles the binary, packs the npm tarball, installs it globally and runs `tg` with
  no Telegram credentials.
- `latest-deps` — weekly (Monday) and on manual runs: `bun update` within the declared ranges,
  then typecheck and the offline suites (no lint: Biome style updates come through Renovate).
  The weekly run also builds with Bun canary.
- `ci` — the gate job and the one required check.

CI has no Telegram secrets; integration tests never run there.

## Troubleshooting

### Tests Hanging

Ensure all Telegram clients are closed. mtcute closes a client with `destroy()`:

```typescript
// In tests, mock the destroy method
destroy: mock(() => Promise.resolve())
```

### Database Locked

Each test should create its own database:

```typescript
beforeEach(() => {
  const { accountsDb } = createTestDatabase()
})
```
