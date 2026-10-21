# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `tg chats sync <chat>` turns background sync on for a chat the default
  policy leaves out, such as a large group or a channel; `--off` stops its
  catch-up and history and `--auto` goes back to the policy. The choice
  survives daemon restarts. Messages that arrive live are cached in every
  chat, whatever its mode.
  The chat is found in the cache by @username, by the ID `tg chats list`
  shows or by a marked ID, without Telegram credentials; for a chat that
  isn't cached yet it suggests starting the daemon or running `tg chats get`.
  While the daemon writes the cache, the command waits for the write lock
  instead of failing.
  A chat you haven't joined, such as a public channel, gets new messages on
  daemon start and after reconnects.
- `tg messages list --chat <peer>` reads a chat's history newest first and
  pages it with `--before` and `--after` (`--limit`, `--includeDeleted`). It
  is cache-first: the cache answers a window only when it holds all of it
  without a gap, otherwise or with `--fresh` Telegram does, and fetched pages
  are cached. Items are the same as in `tg messages search`.
- `tg messages get --chat <peer> --id <id> [--context N]` returns one message
  with up to N messages on each side, cache-first, `--fresh` to fetch. A
  context side the cache doesn't hold whole comes from Telegram.
- The cache records the message ID ranges of each chat that it holds without
  a gap, in the new `history_ranges` table. Every page the daemon or
  `tg messages list` and `get` cache adds one, so reads can't run across
  messages the cache lacks.

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
  sync jobs can reach them. The pass doesn't start syncing them: an archived
  chat starts when a message arrives in it live or when `tg chats sync` turns
  it on.
- Groups whose member count Telegram doesn't report are off by default, like
  groups over 100 members, instead of getting a full-history sync. The daemon
  keeps the last known count when a dialog leaves it out.
- History backfill for a chat without a forward or backward cursor starts at
  the newest page instead of below the oldest cached message, so pages that
  `tg send` or `tg messages list` and `get` cache can't make it skip a gap or
  mark a chat's history complete early.

### Fixed

- History backfill and first pages never ran on accounts with more than a few
  dozen chats, because catch-up for every chat always went first (#6).
- A chat whose first message arrived live never got its first page, so it had
  no cursors and no history. Every enabled chat without a forward cursor now
  gets one, and the daemon caches such a chat from the message, so the first
  page of a new DM or group works before the next dialog pass.
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
- `tg send --to` accepts the marked chat IDs that `tg messages search` and
  `tg sql` print (`-100…` for channels and supergroups, `-N` for basic
  groups), and a cached 10-digit user or chat ID is no longer looked up as a
  phone number.
- `tg send --to +<phone>` reported a rate limit on the phone lookup as a
  number it couldn't resolve. It now fails with `RATE_LIMITED`.
- `tg send --to <user ID>` resolves a user the cache knows without an access
  hash, or whose private chat has cached messages, as that user. Before, a
  short ID became the basic group with the same number and a 10-digit one a
  phone number. Users found by `@username` or phone are cached, so the next
  lookup by ID needs no API call.
- `tg send --to` rejects a malformed number such as `-12.5`, `1e1` or `12.0`
  instead of reading its leading digits as a basic group ID.

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
