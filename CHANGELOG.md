# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `tg chats sync <chat>` turns background sync on for a chat the default
  policy leaves out, such as a large group or a channel; `--off` turns it off
  and `--auto` goes back to the policy. The choice survives daemon restarts.
  The chat is found in the cache by @username, by the ID `tg chats list`
  shows or by a marked ID, without Telegram credentials. While the daemon
  writes the cache, the command waits for the write lock instead of failing.

### Changed

- Forward catch-up runs only for chats that are behind: on start and after
  reconnects, for chats whose newest message in the dialog list is above the
  cursor, and until a gap is closed. It no longer polls every enabled chat
  every 30 seconds. The first catch-up after a restart or reconnect fetches the
  messages received live since the last one again.
- Sync jobs run in three lanes that take turns: catch-up gets half the jobs,
  first pages and history a quarter each, and an idle lane's turn goes to the
  others. Inside a lane, small chats go first. History starts right after a
  chat's first page, and works for every enabled chat, not only small ones.
- The daemon's dialog pass also lists archived chats, so they are cached and
  sync jobs can reach them, but they don't start syncing on their own.
- Groups whose member count Telegram doesn't report are off by default, like
  groups over 100 members, instead of getting a full-history sync. The daemon
  keeps the last known count when a dialog leaves it out.

### Fixed

- History backfill and first pages never ran on accounts with more than a few
  dozen chats, because catch-up for every chat always went first (#6).
- A chat whose first message arrived live never got its first page, so it had
  no cursors and no history. Every enabled chat without a forward cursor now
  gets one.
- An empty chat was marked complete without a cursor and never caught up. Its
  cursors now start at 0, so its first message is caught up like any other.
- The first page and history pages counted messages that were already cached.
  A page of only deleted messages set the backward cursor past every message,
  or in history left it in place, so the same page was fetched forever.
- On a cache from 0.1.4 or earlier, a chat with a forward cursor but no
  backward cursor would start history below its oldest cached message, so the
  messages between that one and the cursor were never fetched, yet history
  ended up marked complete. History now pages down from the forward cursor.
- A CLI command that writes the cache (for example `tg send` or
  `tg chats list --fresh`) failed with "database is locked" if the daemon was
  writing at that moment. It now waits up to 5 seconds for the lock.

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
