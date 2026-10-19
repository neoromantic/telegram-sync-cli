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

Every repo exposes the same script names, so CI and agents need no per-repo knowledge:

| Script | What it does |
|---|---|
| `check` | lint and typecheck (or `lint` and `typecheck` separately) |
| `test` | offline unit tests |
| `test:e2e` | end-to-end tests, still offline |
| `build` | produce the shipped artifact, if any |

- Bun repos: `bun run <script>`. Python repos: `uv run …` (never bare `pip` or `python`).
  Go repos: `go` tooling from `go.mod`.
- Use Bun, uv or Go modules for installs. Use npm only for `npm publish` and `npm view`.

### Definition of done

- The change works end to end, tests cover it, and `check` and `test` pass locally.
- README and docs change in the same commit as the behaviour they describe.
- No new warnings, no commented-out code, no stray debug output.

### Commits and releases

- Conventional Commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `ci:`.
  A breaking change adds `!` (`feat!:`) and a `BREAKING CHANGE:` footer.
- One logical change per commit. Never rewrite published history or force-push `main`.
- Releases happen only through the repo's Release PR or release workflow. Don't bump versions,
  edit `CHANGELOG.md` or push tags by hand.

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
bun run lint                     # Biome
bun run typecheck                # tsgo (typecheck:tsc runs tsc)
bun run test                     # unit tests, offline
bun run test:e2e                 # CLI e2e tests, offline
bun run build                    # compile dist/tg for this platform
bun run build:all                # cross-compile every target
bun run test:integration         # real Telegram API, opt-in (see Testing)
bun run lint:fix                 # Biome autofix (also the pre-commit hook)
```

- `bin/tg.js` is a 3-line ESM shim (`#!/usr/bin/env bun`) that runs `src/index.ts`. The npm
  package ships source, not `dist/tg`, and has no `postinstall`. Requires Bun >= 1.4.
- The version lives only in `package.json` (read by `src/version.ts`).
- The compiled binary (~60 MB, embedded Bun + SQLite) is built locally or in CI, never shipped
  in the npm tarball. Targets: darwin arm64/x64, linux x64/arm64, windows x64.
- Git hooks: `lefthook.yml` runs `lint:fix` and `typecheck` on commit.
- CI: `.github/workflows/ci.yml` runs lint, typecheck, unit, e2e and a build job that compiles
  the binary, packs the tarball, installs it globally and runs `tg --help`/`--version` with no
  Telegram credentials.

### Architecture rules

- **CLI and daemon are the same binary**, in different entry modes.
- **The daemon is read-only.** It never sends, edits or deletes anything. All mutations (send,
  edit, delete, create groups) go through the CLI.
- **One database per account.** Never mix account data.
- **Don't touch mtcute internals or its `session.db`.** Keep our data in parallel tables in
  `data.db`.
- **Credentials are read lazily.** `--help`, `--version` and cache-only commands must work
  without `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`. Only commands that connect call
  `requireDefaultConfig()` in `src/services/telegram.ts`.
- Output is JSON by default with a stable error schema
  (`{ success: false, error: { code, message, details?, suggestion? } }`) and documented exit
  codes. Don't change codes or shapes without updating the docs.

```
CLI mode (tg <cmd>)            Daemon mode (tg daemon start)
  query cache, on-demand API,    real-time updates, backfill,
  mutations                      rate-limit handling (max 5 accounts)
        \                           /
         SQLite (WAL), one data.db per account
```

### Data rules

- Messages are eternal: never treated as stale. Peers (contacts, groups, channels) expire after
  one week. TTLs are configurable, never hardcoded.
- Always store `raw_json` and a `fetched_at` timestamp on cached entities.
- Cache-first: return cached data and refresh in the background; `--fresh` bypasses the cache.
  Never block on stale data.
- Telegram `Long` values (`hash`, `accessHash`) are `BigInt`.

Sync uses two cursors per chat: forward (real-time, catches up on restart) and backward
(history backfill). Priorities: real-time first; DMs and groups under 20 members get full
history; groups of 20–100 get the last 10 messages, then gradual backfill; larger groups and
channels sync only on request. Details: [docs/sync-strategy.md](docs/sync-strategy.md).

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
~/.telegram-sync-cli/  user data: config.json, daemon.pid, accounts/<id>/{session.db,data.db}
```

New commands use `defineCommand` from citty and report through `success()`/`error()` in
`src/utils/output.ts`.

### Testing

- `test-setup.ts` (preloaded via `bunfig.toml`) always overwrites `TELEGRAM_API_ID`/
  `TELEGRAM_API_HASH` with dummies, because Bun auto-loads the developer's `.env` first. Real
  values are stashed as `TELEGRAM_TEST_API_ID`/`TELEGRAM_TEST_API_HASH` for the integration
  suite. CI has no Telegram secrets.
- Unit tests mock the mtcute client and use `createTestDatabase()` for in-memory databases.
- E2E tests spawn the CLI with `bun --no-env-file` and an isolated
  `TELEGRAM_SYNC_CLI_DATA_DIR`:

  ```ts
  const env = createTestEnvironment('my-test')
  env.initDatabase()
  env.seedAccounts([{ phone: '+15550000000', is_active: true }])
  const result = await runCliSuccess(['accounts', 'list'], env.getCliOptions())
  expect(result.json?.success).toBe(true)
  env.cleanup()
  ```

- Integration tests (`src/__integration__/`) hit the real API and are never part of `test`.
  They need `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` (or the `TELEGRAM_TEST_` variants),
  `TELEGRAM_TEST_ACCOUNT` and `TELEGRAM_TEST_SESSION_PATH` (or `TELEGRAM_TEST_SESSION`);
  `TELEGRAM_TEST_RECIPIENT` is optional. `TELEGRAM_API_RECORD=1` records fixtures,
  `TELEGRAM_API_REPLAY=1` replays them offline (`TELEGRAM_API_FIXTURES_DIR` overrides the path).
- Never read or write the real `~/.telegram-sync-cli` from tests.
