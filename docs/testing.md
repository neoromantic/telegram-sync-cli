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

- `auth.test.ts` — authentication flows (phone, QR, logout)
- `db.test.ts` — database operations
- `output.test.ts` — JSON/pretty/quiet output formatting
- `telegram.test.ts` — Telegram service layer
- `sync-jobs.test.ts` — sync job lifecycle
- `update-handlers.test.ts` — daemon update handlers

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
- `user.e2e.test.ts` — `me`, `user` lookups
- `commands.e2e.test.ts` — command coverage smoke tests
- `daemon.e2e.test.ts` — daemon start/stop/status
- `sql.e2e.test.ts` — `tg sql` queries through the real argument parser

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
env.seedAccounts([{ phone: '+1234567890', is_active: true }])

await runCli(['accounts', 'list'], env.getCliOptions())

env.cleanup()
```

## Integration Tests (Real API)

`src/__integration__/` is a live smoke suite: it runs the CLI the way a user would, against the
real Telegram API. It is skipped unless the variables below are set, and it never runs in CI.

| Test | What it proves |
|------|----------------|
| auth status and me | the session is valid; `me --fresh` writes the profile and `me` reads it back from the cache |
| chats and contacts | dialogs and contacts come from the API, then `chats list` serves them from the cache |
| send to Saved Messages | `send --to me` delivers a message; `tg api messages.getMessages` reads it back |
| daemon | the daemon connects, starts real-time updates, bootstraps dialogs (waiting out FLOOD_WAITs), syncs messages into the cache, shows up in `tg status` and stops cleanly with `tg daemon stop` |

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

Ensure all Telegram clients are closed:

```typescript
// In tests, mock the close method
close: mock(() => Promise.resolve())
```

### Database Locked

Each test should create its own database:

```typescript
beforeEach(() => {
  const { accountsDb } = createTestDatabase()
})
```
