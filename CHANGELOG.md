# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `tg sql --account <id|@username|label>` queries that account's cache;
  without it `tg sql` reads the active account's. `tg sql print-schema` needs
  no account and creates no file.
- `CACHE_UNAVAILABLE` (exit 1), with `details: { reason, path }`, when an
  account's cache can't be opened yet: an older tg still holds the shared
  cache (`shared_cache_in_use`), the move failed (`move_failed`), or the file
  belongs to another account (`owner_mismatch`, from the new `cache_meta`
  stamp).
- `tg status` has a `storage` section (`legacy_caches`: shared caches set
  aside; `migration`: a move that waits), and every item in `sync.jobs`,
  `progress.sample_chats` and `rate_limits.active_flood_waits` has
  `account_id`. With several accounts, pretty output tags jobs with
  `acct:<id>` and the retry commands add `--account <id>`.
- `tg status` gives each entry in `accounts.accounts` its own `cache`,
  `connection`, `sync`, `progress` and `rate_limits`, and pretty output
  prints them on a line under each account. `tg status --account <selector>`
  reports only that account and sets the new top-level `account_id` (`null`
  for all); pretty output names that account under the title. `tg daemon status` adds `accounts[]` with each account's
  connection, last error, messages synced and cached, and chat counts, and
  the same `storage` as `tg status`, so a shared cache that an older daemon
  still holds explains why every account reads empty.

### Changed

- **Breaking:** each account has its own cache, `accounts/<id>/cache.db`:
  cached chats, users and messages, sync state, jobs, rate limits and
  `api_activity`. `data.db` keeps only the accounts. Stop the daemon before
  upgrading. The first command that needs a cache moves the shared
  `cache.db` of 0.3 and older, and so do `tg auth login`, `login-qr`,
  `logout` and `tg accounts remove` before they change the accounts: with
  one account it becomes that account's cache and everything carries over;
  with several (or none) its rows can't be split by account, so it is kept
  as `shared-cache.db` and each account syncs again from an empty cache; an
  empty one is deleted. While an older tg still has the file open, a single
  account's commands fail with `CACHE_UNAVAILABLE` until it exits. `tg auth
  login`, `login-qr`, `logout` and `tg accounts remove` fail the same way
  with any number of accounts and change none, so a second account can't
  force the first one's cache aside, and the account left after a removal
  (or the first one added) is never handed rows that other accounts wrote.
  A file that can't be moved yet (`move_failed`: a read-only file, a full
  disk) waits the same way; only a file that is not a database is set aside
  for a single account. A login after `tg auth logout` gives
  the same Telegram user a new account ID and an empty cache; the old
  `accounts/<id>/` stays, and renamed to the new ID it is taken back, as the
  owner stamp matches the user. Going back to 0.3 after the move is not
  supported. Scripts that open `cache.db` directly must open
  `accounts/<id>/cache.db` or use `tg sql --account`. See "Upgrading to
  per-account caches" in `docs/configuration.md`.
- **Breaking:** a command that reads a cache works on one account:
  `--account`, else the active account, else the only one. With no account
  it fails with `AUTH_REQUIRED` (exit 2), so `tg chats get --id <ID>` without
  an account is no longer the `INVALID_ARGS` cache miss of 0.3.0. With
  several accounts and none active it fails with `NO_ACTIVE_ACCOUNT`
  (exit 1) and lists them in `details.accounts`.
- The daemon runs each account with its own cache, scheduler and sync
  worker, taking turns between accounts; each account waits 3 seconds
  between its own jobs. An account whose cache doesn't open is logged and
  left out; one whose scheduler fails its startup pass is logged and keeps
  syncing, and never stops the accounts after it. `daemon_status` rows are per account; `tg status` and
  `tg daemon status` sum them and count only rows the live daemon wrote.

### Fixed

- `tg chats list`, `chats search`, `contacts list`, `messages search` and
  `tg sql` mixed every account's data, and message IDs and basic group IDs
  that two accounts share collided in one cache (#17).
- The daemon ran a sync job on the first connected account's client, with
  another account's access hashes; a job now runs only on its own account's
  client, and a disconnected account's jobs wait for it.
- `tg send` resolved recipients with access hashes that another account
  cached.
- A delete without chat context could mark another account's message with
  the same ID as deleted (the cross-account part of #7).
- A FLOOD_WAIT that one account recorded (one longer than mtcute waits out:
  60 seconds in the CLI, 5 minutes in the daemon) blocked API calls of every
  account. A shorter one that mtcute sleeps through inside a daemon job
  still holds the job loop for every account (#60).
- `tg chats search`, `messages search` and `chats sync` ignored `--account`.
- After a reconnect, a complete dialog pass now marks the account's chats it
  didn't list (left, deleted or migrated) caught up, as the startup pass
  does. Before, such a chat whose newest message an earlier failed pass had
  left unknown still cost a `messages.getHistory` call. A chat turned on with
  `tg chats sync` still gets its checking page.

## [0.3.0] - 2026-10-22

### Added

- `TELEGRAM_PROXY` routes CLI and daemon connections through a proxy using
  mtcute's URL parser: `socks4://`, `socks5://`, `http://`, `https://` and
  MTProxy links. Credentials go in the URL; `socks5h://` and addresses without
  a scheme are unsupported. Invalid URLs fail with a configuration error
  without printing the URL. Unset keeps direct TCP; `ALL_PROXY` and
  `HTTPS_PROXY` are ignored (#48).

### Changed

- **Breaking:** `id` in `tg chats list`, `get`, `search` and `sync` is now the
  chat's marked peer ID, the one `tg messages search` and `tg sql` print: the
  user ID for a private chat, `-N` for basic group N, `-100…` for a supergroup
  or channel. `chats_cache.chat_id` in `tg sql` holds the same IDs, so it
  joins `messages_cache.chat_id`. `tg chats sync` still prints `peerId`, now
  equal to `id`. The bare group or channel ID that 0.2.0 printed still works
  in `tg send --to`, `tg messages list` and `get --chat`, `tg chats get --id`
  and `tg chats sync` when the cache knows the chat; one that names both a
  cached basic group and a cached channel fails with `INVALID_ARGS` and lists
  both marked IDs. A positive ID the cache knows as a user (a private chat,
  a cached user, a DM with sync state or cached messages) names that user in
  every command, never a group or channel.
  To upgrade, stop the daemon, upgrade, then start it. The first run of the
  new version converts the cache and rebuilds the search index once. A 0.2.0
  daemon left running fails group and channel sync jobs until it is
  restarted, and the chats it caches are converted on the next run. The
  group and channel senders and forward sources in the messages that it, or
  a second 0.2.0 install, caches after the upgrade keep their bare IDs in
  `fromId` and `forwardFromId`, and may show the name of the user with that
  ID, until the message is fetched again (`tg messages list --fresh`).
  Downgrading after that is not supported.
- **Breaking:** `fromId`, `sender.id` and `forwardFromId` in
  `tg messages search`, `list` and `get` hold the marked ID of a group or
  channel that posts as itself or that a message was forwarded from (`-N`,
  `-100…`), as `messages_cache.from_id` and `forward_from_id` store them
  now. History pages, `tg send` and live forwards stored the bare ID before;
  the first run converts the cached messages. `tg messages search --sender`
  takes the marked ID for such a sender (`--sender -1001234567890`), so a
  script that passes or matches the bare ID stops matching.

### Fixed

- `tg messages search`, `list` and `get` printed `null` for the title,
  username and type of every group and channel chat, because `chats_cache`
  stored those chats under bare IDs and `messages_cache` under marked ones.
  `--chat @username`, SQL joins between the two tables and a search for a
  chat's title now find group and channel messages too (#18).
- User N and basic group N were stored under the same `chats_cache` key and
  overwrote each other, so the daemon could build a user peer for the group's
  sync jobs. They are now separate rows.
- A message that a channel or group posted as itself got the name of the
  user whose ID equals the chat's bare ID, in `sender` and in the search
  index. It now has no user name.
- `tg chats sync -1001234567890 --format pretty` (or `-f pretty`) took
  `pretty` for the chat and failed with "Chat not found in the cache:
  pretty", so the ID copied from `tg chats list` failed for every group and
  channel with that flag. The marked ID now wins.
- `tg chats get --id <ID>` for a chat the cache doesn't hold failed with
  "No active account" or a missing-credentials error, though Telegram is
  asked by @username only. It now fails with `INVALID_ARGS`: the chat isn't
  in the cache, with the suggestion to start the daemon or use @username.

## [0.2.0] - 2026-10-21

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
  instead of failing. Running it again with the chat's mode on a chat whose
  sync jobs failed deletes them, so the daemon retries them at its next
  refresh.
  A chat you haven't joined, such as a public channel, gets new messages on
  daemon start and after reconnects.
- `tg messages list --chat <peer>` reads a chat's history newest first and
  pages it with `--before` and `--after` (`--limit`, `--includeDeleted`). It
  is cache-first: the cache answers a window only when it holds all of it
  without a gap, otherwise or with `--fresh` Telegram does, and fetched pages
  are cached. Items are the same as in `tg messages search`.
- `tg messages get --chat <peer> --id <id> [--context N]` returns one message
  with up to N messages on each side, cache-first, `--fresh` to fetch. A
  context side the cache doesn't hold whole comes from Telegram, and if
  Telegram can't be asked, a cached message comes back with the context the
  cache holds.
- The cache records the message ID ranges of each chat that it holds without
  a gap, in the new `history_ranges` table, which `tg sql print-schema`
  describes. Every page the daemon or `tg messages list` and `get` cache adds
  one, so reads can't run across messages the cache lacks.

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
- A `FLOOD_WAIT` too long for the client to wait out failed a command with
  `TELEGRAM_ERROR`; only later calls to the blocked method got
  `RATE_LIMITED`. Every command that calls Telegram now reports it as
  `RATE_LIMITED` with `wait_seconds` right away.
- `tg send --to <user ID>` resolves a user the cache knows without an access
  hash, or whose private chat has cached messages, as that user. Before, a
  short ID became the basic group with the same number and a 10-digit one a
  phone number. Users found by `@username` or phone are cached, so the next
  lookup by ID needs no API call.
- `tg send --to` rejects a malformed number such as `-12.5`, `1e1` or `12.0`
  instead of reading its leading digits as a basic group ID.
- `tg send --to '+1 (555) 000-0000'`, or a `+` number with spaces or dashes,
  looked the number up as a username. A `+` now always means a phone number.
- Failed sync jobs retry with backoff (1, 2, 4 and 8 minutes) and fail after
  five attempts. A FLOOD_WAIT delays the job instead of failing it, and a
  permanent error, such as `CHANNEL_PRIVATE` or a chat without an InputPeer,
  fails it at once. Before, the next refresh queued a failed chat again every
  30 seconds forever and left a failed row each time. Failed rows are now
  cleaned up after 24 hours or on a daemon restart, and the chat is tried
  again then. A job whose chat is turned off while it runs is dropped if it
  fails (#9).
- `tg status` counts failed sync jobs (`failed_jobs` was always 0) and lists
  the newest ones with their attempts, error and chat mode (`sync_mode`), and
  the pretty output prints the `tg chats sync` command that retries each
  chat's failed jobs without changing its mode. It also counts the jobs
  waiting for a retry (`retrying_jobs`) and shows when they run again.

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

[Unreleased]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/neoromantic/telegram-sync-cli/releases/tag/v0.1.2
