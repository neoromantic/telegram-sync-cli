# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Groups whose member count Telegram doesn't report are off by default, like
  groups over 100 members, instead of getting a full-history sync. The daemon
  keeps the last known count when a dialog leaves it out.

## [0.1.4] - 2026-10-21

### Fixed

- After a failed connection check the daemon reconnected without real-time
  updates, left the old connection open on the same session and kept syncing
  through it, so it quietly stopped caching new messages. A reconnect now
  closes the old client and restores updates and sync on the new one.
- `tg send` didn't add the sent message to the cache, so `tg messages search`
  missed it until a later sync, even with the daemon running.
- The daemon lost messages that arrived while it was stopped: the first live
  message after a restart moved the chat's forward cursor past them, and
  catch-up fetched only the newest 100. Live updates no longer move the
  cursor, and catch-up pages up from it until it reaches the newest message.

## [0.1.3] - 2026-10-21

### Added

- `tg send --to me` (or `self`) sends to Saved Messages.
- A live smoke suite (`bun run test:integration`) covers auth, the profile,
  chats, contacts, sending and the daemon against the real API.
- Standalone binaries for macOS, Linux and Windows on every GitHub Release,
  and a Homebrew formula: `brew install neoromantic/tap/tg`.

### Changed

- Upgraded mtcute to 0.32.6 and switched type checking to TypeScript 7.
- CI runs on the shared devkit reusable workflows; git hooks run gitleaks and
  a privacy scan.
- `AGENTS.md` is the canonical agent guide; the roadmap became a known-gaps
  list linking GitHub issues.

### Fixed

- `tg sql --query "…"` failed with "Missing required positional argument".
  The `-q` short alias is gone: it always meant the global `--quiet`.
- The daemon's dialog bootstrap gave up on the first long FLOOD_WAIT, so
  large accounts got a partial chat list. The daemon now waits out
  FLOOD_WAITs of up to 5 minutes.
- `tg contacts list` from the cache missed contacts once more than 1000 users
  were cached.
- Messages received in real time were stored without `raw_json`.
- `tg daemon stop` printed a progress line to stdout before the JSON.

## [0.1.2] - 2026-10-19

### Added

- Daemon bootstraps the dialog list on start and reports sync progress.

### Changed

- `tg` now runs the TypeScript source directly with Bun through an ESM `bin`
  shim. Installing no longer compiles a native binary, so there is no
  `postinstall` step. Requires Bun >= 1.4.
- The CLI version is read from `package.json` (single source of truth).
- README no longer contains a personal phone number.

### Fixed

- `tg --help`, `tg --version`, subcommand `--help` and offline commands
  (`accounts`, `config`, `sql`, cached queries) work without
  `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`. Commands that talk to Telegram
  report missing credentials as `INVALID_ARGS` (exit code 3).
- `bun install -g` and `npm install -g` produce a working `tg` command (the
  0.1.1 `postinstall` build was blocked by Bun and skipped by newer npm).
- The "No active account" error now points to `tg auth login` instead of the
  nonexistent `tg accounts add`.

## [0.1.1] - 2026-02-04

Earlier releases (0.1.0, 0.1.1) predate this changelog.

[Unreleased]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.4...HEAD
[0.1.4]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/neoromantic/telegram-sync-cli/releases/tag/v0.1.2
