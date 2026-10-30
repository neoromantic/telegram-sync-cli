# telegram-sync-cli

<!-- devkit:agents v1 -->
<!-- managed by devkit v1: edit in https://github.com/neoromantic/devkit/blob/main/agents/AGENTS.shared.md -->
## Shared rules (devkit)

These rules apply to people and coding agents in every repo that uses
[devkit](https://github.com/neoromantic/devkit). Project rules follow in `## Project` below.
Where they conflict, the project section wins.

### Data

- Use only made-up data in tests, fixtures, examples, docs and screenshots. No real people, chats,
  phone numbers, tokens, session files or local paths such as home directories.
- Never commit `.env` files or credentials. Tests run offline by default; live API tests are
  opt-in and read their credentials from the environment.

### Commands

Use the project section's native commands for checks, offline tests and builds:

- Bun: `bun run <script>` (`check`, or `lint` and `typecheck`; `test`, `test:e2e`, `build`).
- Python: the documented `uv run` / `uvx` commands, such as pytest, unittest and ruff.
- Go: the documented `go` commands from `go.mod`. Do not add Bun wrappers for Python or Go.
- Use Bun, uv or Go modules for installs. Use npm only for `npm publish` and `npm view`.

### Definition of done

- The change works end to end and the project's applicable checks and tests pass locally.
- README, docs and affected demos change with the behaviour they describe; follow the
  [product content standard](https://github.com/neoromantic/devkit/blob/main/docs/standards/product-content.md).
- No new warnings, no commented-out code, no stray debug output.

### Commits and releases

- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`.
  A breaking change adds `!` (`feat!:`) and a `BREAKING CHANGE:` footer.
- One logical change per commit. Never rewrite published history or force-push `main`.
- Follow the project's documented release procedure, including any owner-only steps. It defines
  versioning, tags, changelog and delivery (release, skill revision or production deployment).

### Files

- Don't add planning or progress files (`progress.md`, `docs/plans/`). Plans live in issues.
  `ROADMAP.md`, if present, is a short "Known gaps" list that links issues.
- Don't add agent hooks that rewrite tracked files.
- `AGENTS.md` is the canonical instruction file. `CLAUDE.md` contains only `@AGENTS.md`.
- Files marked "managed by devkit" (this block, `SECURITY.md`, `CONTRIBUTING.md`, the PR
  template, `.gitleaks.toml`, `.github/zizmor.yml`, `renovate.json`, `lefthook.yml` and the
  CI stub) are synced from devkit. Change them there, not here.
<!-- /devkit:agents -->

## Project

`tg` is a Telegram CLI for people and AI agents: a local SQLite cache, a read-only sync daemon
and raw access to any MTProto method. It runs on Bun and is built on
[mtcute](https://mtcute.dev). Long-form docs live in [`docs/`](docs/).

### Commands

```bash
bun run src/index.ts <command>   # run the CLI from source
bun run check                    # lint (Biome) + typecheck
bun run test                     # unit tests, offline
bun run test:e2e                 # CLI e2e tests, offline
bun run build                    # compile dist/tg for this platform
bun run build:all                # cross-compile every target
bun run test:integration         # real Telegram API, opt-in (see Testing)
bun run lint:fix                 # Biome autofix (also the pre-commit hook)
bun run bench:storage            # storage benchmark on made-up data, opt-in (docs/storage.md)
```

- `bin/tg.js` is a 3-line ESM shim (`#!/usr/bin/env bun`) that runs `src/index.ts`. The npm
  package ships source, not `dist/tg`, and has no `postinstall`. Requires Bun >= 1.4.
- The version lives only in `package.json` (read by `src/version.ts`).
- The compiled binary (70–100 MB, embedded Bun + SQLite) is never shipped in the npm tarball.
  The release workflow attaches one per target to the GitHub Release, and the Homebrew formula
  `neoromantic/tap/tg` installs it. Targets: darwin arm64/x64, linux x64/arm64, windows x64.
- Git hooks: `lefthook.yml` runs `lint:fix` and `typecheck` on commit, plus devkit's gitleaks
  and privacy scan (needs `gitleaks` on `PATH`).
- CI: `.github/workflows/ci.yml` calls devkit's `ci-bun` (check, build, test, test:e2e) and
  `hygiene` workflows and adds a `pack` job that compiles the binary, packs the tarball,
  installs it globally and runs `tg --help`/`--version` with no Telegram credentials. A weekly
  run (Monday) uses Bun canary and refreshes dependencies within their ranges. The required
  check is `ci`.

### Releasing

Releases are tag-driven: a `chore(release): X.Y.Z` PR bumps `package.json` and dates the
`CHANGELOG.md` section, then a pushed `vX.Y.Z` tag runs `.github/workflows/release.yml` (npm with
trusted publishing, the GitHub Release with binaries, the Homebrew formula). This replaces the
shared rule about Release PRs; until then, changes add their entry under `## [Unreleased]`.
Steps: [docs/releasing.md](docs/releasing.md).

### Architecture rules

- **CLI and daemon are the same binary**, in different entry modes.
- **The daemon is read-only.** It never sends, edits or deletes anything. All mutations (send,
  edit, delete, create groups) go through the CLI.
- **One cache database per account.** `data.db` holds only the accounts. Each account's
  cache, sync state, jobs and rate limits live in `accounts/<id>/cache.db`. A command opens
  one account's cache: `resolveAccount` (`--account`, else the active account, else the only
  one) and `getAccountCacheDb` in `src/db/index.ts`. The daemon keeps a runtime per account
  (cache, scheduler, sync worker), and a job runs only on its own account's client. Never mix
  account data.
- **Don't touch mtcute internals or its `session.db`.** Keep our data in parallel tables in
  `data.db`.
- **Credentials are read lazily.** `--help`, `--version` and cache-only commands must work
  without `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`. Only commands that connect call
  `requireDefaultConfig()` in `src/services/telegram.ts`.
- **Usage stats never carry user content.** `src/telemetry/client.ts` is devkit's client
  (managed, never edited here); `src/telemetry/index.ts` decides what tg passes to it. Features
  are command paths from the dispatcher, never arguments. `error()` reports only its code or
  Telegram's RPC error name; pass a message (`reportLocalError`) only for config and cache file
  errors, never one that can hold message text, chat, contact or user names, or a query. Every
  exit goes through `exitAfterFlush`, never a bare `process.exit`: a command exits at once and
  hands its events to a detached copy of tg that sends them (`src/telemetry/background.ts`,
  `send.ts`); only the daemon and debug mode send in-process and wait up to 500 ms.
- Output is JSON by default with a stable error schema
  (`{ success: false, error: { code, message, details?, suggestion? } }`) and documented exit
  codes. Don't change codes or shapes without updating the docs.

```
CLI mode (tg <cmd>)            Daemon mode (tg daemon start)
  query cache, on-demand API,    real-time updates, backfill,
  mutations                      rate-limit handling (max 5 accounts)
        \                           /
   SQLite (WAL): data.db (accounts), accounts/<id>/cache.db per account
```

### Data rules

- Messages are eternal: never treated as stale. Peers (contacts, groups, channels) expire after
  one week. TTLs are configurable, never hardcoded.
- Always store `raw_json` and a `fetched_at` timestamp on cached entities.
- Cache-first: return cached data and refresh in the background; `--fresh` bypasses the cache.
  Never block on stale data.
- Telegram `Long` values (`hash`, `accessHash`, `groupedId`) are objects of the `long` library
  in mtcute (`{ low, high, unsigned }`), never `BigInt`; `raw_json` stores them as decimal
  strings (`toRawJson` in `src/utils/raw-json.ts`).
- Every cache table stores a chat under its marked peer ID (user ID, `-N` for basic groups,
  `-100…` for supergroups and channels). Convert IDs only in `src/utils/telegram-peer-ids.ts`.

Sync uses two cursors per chat: forward (every message up to it is cached; only sync jobs
move it, never live updates) and backward (history backfill). Catch-up runs only for chats
whose newest message (`top_message_id`, from the dialog pass on start and after reconnects and wakes) is
above the forward cursor, never as polling. Priorities: real-time first; DMs
and groups under 20 members get full history, but bots and deleted accounts get only the newest
100 messages and catch-up; groups of 20–100 get the newest 100 messages,
then history after the small chats; groups of unknown size or over 100 members and channels
get catch-up and history only on request (`tg chats sync`). Every message that arrives live is
cached, in any chat; Telegram may push few posts of channels, so each dialog pass also caches
the newest message of every chat with sync off. Details: [docs/sync-strategy.md](docs/sync-strategy.md).

### Bun-native APIs

Prefer `bun:sqlite` (not better-sqlite3), `Bun.file()`/`Bun.write()` (not `fs`), `Bun.$` (not
`child_process`/execa). Bun auto-loads `.env`, so no dotenv.

### Code layout

```
bin/tg.js            npm bin shim
src/index.ts         CLI entry (citty)
src/commands/        one file or folder per command group (auth, accounts, chats, send, sql…)
src/services/        Telegram client manager (lazy credentials)
src/db/              schema, caches, sync jobs, per-chat sync state, rate limits
src/daemon/          daemon entry, loop, scheduler, update handlers, sync workers
src/utils/           output, args, formatting, mappers, peer resolution
src/__tests__/       unit tests      src/__e2e__/  CLI e2e      src/__integration__/  live API
~/.telegram-sync-cli/  user data: config.json, daemon.pid, data.db (accounts),
                       session_<id>.db (mtcute), accounts/<id>/cache.db (the
                       account's cache, sync state, jobs, rate limits)
```

New commands use `defineCommand` from citty and report through `success()`/`error()` in
`src/utils/output.ts`.
Import mtcute values and types (`tl`, `TelegramClient`, `networkMiddlewares`) from
`@mtcute/bun`, the only mtcute package in `package.json`; `@mtcute/core` and `@mtcute/tl` are
not direct dependencies (and `@mtcute/tl` no longer exists since mtcute 0.29).

### Testing

- `test-setup.ts` (preloaded via `bunfig.toml`) always overwrites `TELEGRAM_API_ID`/
  `TELEGRAM_API_HASH` with dummies, because Bun auto-loads the developer's `.env` first. Real
  values are stashed as `TELEGRAM_TEST_API_ID`/`TELEGRAM_TEST_API_HASH` for the integration
  suite. CI has no Telegram secrets. It also always points `TELEGRAM_SYNC_CLI_DATA_DIR` at
  `.tmp/test-data-<pid>`, even if the shell or `.env` sets it, and sets
  `TELEGRAM_SYNC_CLI_TELEMETRY=0` (usage stats off).
- Unit tests mock the mtcute client and use `createTestDatabase()` for in-memory databases.
- E2E tests spawn the CLI with `bun --no-env-file` and an isolated
  `TELEGRAM_SYNC_CLI_DATA_DIR`:

  ```ts
  const env = createTestEnvironment('my-test')
  env.initDatabase()
  env.seedAccounts([{ phone: '+15550000000', is_active: true }])
  createChatsCache(env.openCacheDb(1)).upsertMany(chats) // env.cachePath(1)
  const result = await runCliSuccess(['chats', 'list'], env.getCliOptions())
  expect(result.json?.success).toBe(true)
  env.cleanup()
  ```

  A test that writes `<dataDir>/cache.db` (the shared cache of 0.3 and older) seeds it from a
  child process with `seedInChild`: a file the test process wrote stays open after `close()`,
  and tg moves the file only when no other process has it open.

- Integration tests (`src/__integration__/`) are a live smoke suite against the real API and
  are never part of `test`. They need `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` (or the
  `TELEGRAM_TEST_` variants), `TELEGRAM_TEST_ACCOUNT` and `TELEGRAM_TEST_SESSION_PATH` (or
  `TELEGRAM_TEST_SESSION`), pointing at a session logged in only for tests. Each test copies the
  session into a temp data dir; messages go only to the account's Saved Messages and are
  deleted afterwards. Run them after changes to Telegram calls, sync or the daemon.
  `TELEGRAM_API_RECORD=1` records fixtures, `TELEGRAM_API_REPLAY=1` replays them offline
  (`TELEGRAM_API_FIXTURES_DIR` overrides the path); the daemon test needs a live connection.
- Never read or write the real `~/.telegram-sync-cli` from tests.
