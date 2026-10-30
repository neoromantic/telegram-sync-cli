# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.0] - 2026-10-30

Fixes from a day of running the daemon on a real account. Restart the daemon after
the upgrade: its first dialog pass catches up the messages an earlier version missed
after a laptop sleep or a network drop (#124).

### Added

- `tg status` shows how far the history backfill is: `progress.history` gives the messages
  cached of the counts Telegram gives on sync pages, the messages and chats left, the 5 chats
  with the most left, and the time left at the pace of the last 15 minutes of history pages
  (none without a measured pace); each account gets its own figures. Pretty output shows
  History Cached and History Left (#126).

### Fixed

- A channel with sync off now has its newest post cached: Telegram may push
  few live posts of a channel, or none, and mtcute can't fetch the ones it
  missed, so every dialog pass (on start, after a reconnect and after a wake)
  caches the newest message of each chat with sync off. The docs now say which
  messages arrive live (#125).
- The daemon catches up after mtcute reconnects on its own (a network drop)
  and after the computer wakes from sleep, not only after its own reconnect:
  it watches the connection state and the wall clock, runs the dialog pass on
  the client it has and queues catch-up for the chats that got messages
  meanwhile, at most once per account in 5 minutes. It logs one line, and
  `tg status` shows the last one in `accounts.accounts[].connection.last_catch_up`
  (#124).
- The daemon log is quieter and keeps personal data out: it names an account
  `#1 (@username)` or by a masked phone, never the full number or name;
  mtcute's warnings show only with `--verbose`, its update gap notes at debug
  level; and a Telegram client error is one line, without the stack or the
  compiled binary's source (#128).
- Usage stats no longer slow down a command (#129). Every command used to wait up
  to half a second for them before it exited; now a background copy of tg sends
  them after the command has exited, so `tg status` takes as long as with
  `DO_NOT_TRACK=1`, even when the network is slow or down. The daemon still sends
  from its own process.
- The daemon's sync pages now cache their senders, as `tg messages list` does, before the
  messages, so search shows the sender's name and `--sender` finds their messages in groups.
  Messages synced before keep their index without the name until they are re-indexed (#93).
  The pages also store the chat's message count on the server in
  `chat_sync_state.total_messages`, which stayed empty (#126).
- `tg status` `rate_limits.api_calls_last_minute` and `calls_by_method` count the last 60
  seconds instead of the current calendar minute, which showed 2 calls while the daemon made
  about 14 a minute (#127).
- The daemon logs every request it sends to `api_activity` (method, outcome, Telegram's error
  code, duration), as CLI commands do: sync pages, contacts checks, dialog passes, `getMe`
  health checks and mtcute's update requests; it logged none. `api_activity`
  timestamps are in ms, as documented: older versions wrote seconds, and the next prune turns
  those rows into ms (#127).

## [0.8.0] - 2026-10-29

After the upgrade the daemon rewrites what older versions cached, a little each
second, in the background (#89): `raw_json` gets smaller and older media messages
get their attachment rows. `tg status` shows the progress; without the daemon,
`tg db migrate` does it in the foreground. When it is done, `tg db vacuum` gives
the freed space back to the disk.

### Added

- Background migrations: a rewrite of every row of a big cache now runs in
  small batches, each a short write, and resumes where it stopped. The
  daemon runs them a little each second, after its sync work; live updates
  and sync jobs wait for one batch at most. `tg db migrate [--account]`
  finishes them in the foreground, with or without the daemon. `tg status`
  lists each unfinished one with its progress (`migrations`, and
  `accounts.accounts[].migrations`) and suggests `tg db vacuum` for the
  space they free (#89).
- The first background migrations rewrite what older versions cached:
  `raw_json` of messages, users and chats into the current form, a
  `message_attachments` row for every older media message, and the
  `message_type` of older history messages (a video is `video`, no longer
  `document`). Reads give the same answers while they run (#89, #22).
- `bun run bench:storage`: a storage benchmark that builds a made-up cache of any size through
  tg's own write paths and reports bytes per message by table, write rates, query times,
  `tg db migrate` on old-form rows, `tg db vacuum` and a search index rebuild. `docs/storage.md`
  gives the numbers for 100,000, 1M and 10M messages and the storage decisions they back (#80).

### Changed

- `raw_json` stores 64-bit values (`id`, `accessHash`, `groupedId` and
  others) as decimal strings, as it did `bigint`s, instead of objects with
  `low`, `high` and `unsigned`: `json_extract(raw_json, '$.accessHash')` in
  `tg sql` gives the hash (#108).
- `raw_json` no longer stores `fileReference`: Telegram's file references
  expire, and `tg media download` fetches the message again for a fresh
  one. A made-up photo message takes 1,776 bytes instead of 1,898 (#95).

### Fixed

- `tg sql print-schema --output=sql` and `--output=text` print the schema
  again: `tg sql` rejected every format but `json` and `csv` before
  `print-schema` ran. An unknown `--output` now returns `INVALID_ARGS` in the
  JSON error schema, and `--output` may also come before the subcommand
  (`tg sql -o sql print-schema`) (#109).
- `tg db migrate` next to a running daemon no longer locks the daemon's
  writes out: it ran its batches back to back, and on a big cache a daemon
  write could give up with `database is locked`. With the daemon running it
  now pauses 150 ms after each batch of at most 50 ms, so a daemon write
  waits for one batch at most; the run takes four to five times as long as
  with the daemon stopped (#89).

## [0.7.0] - 2026-10-29

Privacy change: tg now sends usage stats to its author, on by default: how often it runs, which
commands run (`chats list`, never their arguments), the error codes they end with, the version,
how it was installed and the OS, tied to a random install ID. It never sends messages, chat or
contact names, phone numbers, account, chat or user IDs or queries. Nothing is sent until tg
has shown a one-line notice, or from CI, tests or a source checkout. Turn it off with
`tg telemetry off`, `TELEGRAM_SYNC_CLI_TELEMETRY=0` or `DO_NOT_TRACK=1`; everything that is
sent is listed on https://usage.sergeybaus.com.

### Added

- Usage stats, through usage.sergeybaus.com to PostHog. A run sends `app_started`, the command
  path as `feature_used` and, when it fails, the error code or Telegram's RPC error name
  (`FLOOD_WAIT`) as `error_occurred`; an error reading `config.json` or a cache also sends its
  message, without account numbers, a data directory set by `TELEGRAM_SYNC_CLI_DATA_DIR`, the
  home folder or the user name. The daemon and runs from a script send each event at most once
  a day, and the daemon checks in hourly while it runs. Every exit waits at most 500 ms for the requests in flight. Details:
  README "Usage stats" and `docs/configuration.md#usage-stats`.
- `tg telemetry status [--json]`, `tg telemetry on` and `tg telemetry off`: whether usage stats
  are on and which rule decided, the install ID and the state file (`telemetry.json` in the
  data directory); `off` also deletes the install ID.
- The Homebrew formula's caveats repeat the notice, and its test runs with usage stats off.
- `tg messages list`, `get` and `search` items have `attachment`: the
  message's file with its kind (photo, video, video note, GIF, voice, audio,
  sticker, document), file name, MIME type, size, duration, dimensions, album
  ID and `uniqueFileId`, or `null`. It is read from `raw_json`, so messages
  cached before have it too. For `tg sql`, the new table
  `message_attachments` holds the same for messages written from now on;
  older messages get their rows later (#89, #22).
- `tg media download --chat <chat> --id <message>` saves a message's file
  into the account's media cache, `accounts/<id>/media`, and prints its path.
  A cached file needs no network and no credentials. Otherwise the message
  is fetched again for a fresh file reference, and a partial download
  resumes on the next run. `--out` copies the file to a directory or a path
  (`FILE_EXISTS` unless `--overwrite`), `--out -` writes it to stdout, and
  `--thumb` fetches its small preview. Media from chats and messages with
  content protection, and self-destructing media, is refused with
  `CONTENT_PROTECTED`. New error codes, all exit 1: `NO_MEDIA`,
  `MESSAGE_NOT_FOUND`, `CONTENT_PROTECTED`, `MEDIA_UNSUPPORTED` (files from
  Telegram's CDN) and `FILE_EXISTS`. See `docs/media.md` (#22).
- `tg media clean` removes partial downloads untouched for a day; with
  `--older-than`, `--chat` or `--all` it removes cached files too, and
  reports the bytes it freed (#22).
- `tg send --file <path> [--caption <text>]` sends one file: a JPEG, PNG or
  WebP image up to 10 MB as a photo, anything else as a document
  (`--force-document` for an image too). The sent message is cached with its
  attachment (#22).
- `tg status --sizes` shows each account's media cache
  (`accounts.accounts[].media`, `storage.media_bytes`), counted apart from
  the cache database (#22).

### Changed

- History sync writes the same `message_type` and `has_media` as live
  updates: `voice`, `video`, `sticker`, `audio` and `dice` instead of
  `document` or `media`, and `has_media` 0 for media Telegram apps don't show
  (unsupported media, an expired photo, a link preview still pending).
  Messages cached before keep their values until they are fetched again
  (#22).

## [0.6.0] - 2026-10-28

Stop the daemon before you upgrade and start it again after: the first open
of a cache replaces its search trigger and drops an index nothing used
(#87). Then `tg db vacuum` gives that index's space back. `tg messages search`
now reads a query the way FTS5 does: `hello world` finds both words
anywhere, and `--phrase` gives the old exact-phrase search (#84).

### Added

- `tg messages search` filters by date and ranks by relevance. `--since` and
  `--until` take a date, a date and time, or a duration back from now (`7d`,
  `24h`); `--sort relevance` puts the best matches first; `--count` also
  returns how many messages match over all pages, as `count`. `total` is
  still the number of results on the page (#85).
- `tg messages search --snippet` adds a short fragment of each message around
  the matched words, with the words in `**`, for Latin and Cyrillic text and
  prefixes like `квартир*`. For `tg sql`, the new view `message_search_text`
  returns full-text matches with the message text, chat and sender, so
  `WHERE message_search_text MATCH 'deploy' ORDER BY rank` needs no join. The
  view stores nothing, so the cache stays the same size (#81).

### Changed

- `raw_json` stores byte fields, such as a photo's `fileReference` and its
  stripped thumbnail, as base64 strings instead of objects with a key per
  byte. A made-up photo message's `raw_json` drops from 10,213 to 1,896
  bytes. Every cached message, chat and user is written this way; rows cached
  before keep the old form until they are fetched again.
  `docs/database-schema.md` shows how to read the fields with `json_extract`
  (#86).
- A message fetched again with nothing changed is no longer written again,
  and its search index entry is left alone. Catch-up after every daemon
  restart or reconnect fetches again the messages that arrived live, so each
  of them used to cost a row rewrite and a re-index. A message is re-indexed
  only when its text, sender or media path changes; a change only in
  `raw_json`, such as a channel post's views, updates the row but not the
  index, and marking a message deleted no longer re-indexes it. A side effect
  of the old re-indexing goes away: a re-fetch no longer refreshes the sender
  and chat names stored in the index, so a renamed user or chat is found by
  the new name only in messages indexed after the rename. Results still show
  the current names (#93 tracks re-indexing after a rename). The first open of
  an existing cache replaces its search trigger (#87).
- The cache no longer keeps an index on `messages_cache.fetched_at`: no query
  used it, and it took space for every message. The first open of an
  existing cache drops it; `tg db vacuum` gives the space back (#87).
- `tg messages search` reads a query the way FTS5 does. `hello world` now
  finds messages with both words anywhere in them, not only the exact phrase;
  pass `--phrase` for the old behaviour. Operators, phrases, column filters and
  prefixes work as `--help` and `docs/search.md` describe them: `error OR
  timeout`, `"exact phrase"`, `sender:alice`, `chat:team`, and `квартир*` for
  every form of a word. A query FTS5 can't parse returns `INVALID_ARGS` with a
  suggestion instead of `TELEGRAM_ERROR` (#84).

### Fixed

- `tg sql` can no longer change the cache with a pragma. It let
  `PRAGMA user_version = 0` through, which made the next start run the
  one-time migrations again. Queries now run on a read-only connection and
  such a statement, in either form (`PRAGMA writable_schema(1)` too), returns
  `SQL_WRITE_NOT_ALLOWED`. A query with more than one statement returns
  `SQL_OPERATION_BLOCKED` instead of running only the first. Reading pragmas such as
  `PRAGMA table_info(messages_cache)` works, and no longer fails with a
  syntax error from the row limit (#88).

## [0.5.0] - 2026-10-22

Stop the daemon before you upgrade and start it again after: the first open
of a cache moves its search index to the new format (#1). Then run
`tg db vacuum` once with the daemon stopped, to give the old index's space
back to the disk.

### Added

- The cache no longer only grows. `tg status` shows each account's cache
  size, its WAL and the free space inside it, and `tg status --sizes` adds the
  size of each table. The daemon now deletes old API activity, expired
  rate-limit windows and old finished and failed sync jobs on a schedule;
  until now nothing pruned the first two, so they grew forever. How long it
  keeps each is set in `config.json` under `cache.retention`, and it never
  forgets a FLOOD_WAIT that is still running. The new
  `tg db vacuum [--account]` gives free space back to the disk and reports the
  bytes before and after. It works while the daemon runs on caches created by
  this version, and older caches need one run with the daemon stopped. Where
  SQLite is 3.43 or newer, the search index no longer keeps its own copy of
  every message's text, sender and chat, which makes a cache about 11–18%
  smaller; `tg messages search` results stay the same (#1).
- The daemon now keeps each account's contact list current. On each start
  and reconnect, and then every peer TTL (`cache.staleness.peers`, one week by
  default), it checks the list in the background with a hash, so an unchanged
  list costs one tiny reply and no contact writes. The first start after the
  upgrade fetches the full list once. Contacts added or removed on another
  device while it runs are applied when Telegram sends the update. The check
  covers who is a contact; names, usernames and phones still refresh with a
  changed list or `tg contacts list --fresh` (#8).

### Changed

- `tg sql` queries that read the search index's own columns
  (`message_search.text`, `sender`, `chat`, `files`) now get `NULL`, and
  `snippet()` and `highlight()` over it no longer work, because the index
  keeps no copy of the text (#1). Join `messages_cache` by rowid for the text,
  as `tg messages search` does. Getting snippets back is #81.

### Fixed

- With several accounts, the daemon ran one sync job at a time over all of
  them, so while one account's job waited out a FLOOD_WAIT (up to 5 minutes),
  every other account's sync stopped too, and with three or more busy
  accounts each one synced more slowly than alone. Each account now runs its
  own jobs, one at a time and 3 seconds apart as before, so one account's
  FLOOD_WAIT or slow page no longer holds the others, and `tg daemon stop`
  still ends every account's wait at once (#60).
- `tg chats list --type community` found no communities: Telegram lists a
  joined community apart from the other dialogs, and the daemon's dialog pass
  and `tg chats list --fresh` skipped it. Both now also cache every community
  the account joined, with its access hash, at the cost of one extra request.
  If that request fails, a FLOOD_WAIT included (it is not waited out), the
  dialogs are still cached and the next pass retries. A community has no
  messages of its own, so `tg chats sync <community>` no longer turns sync on
  for jobs that would fail: it exits with `INVALID_ARGS` and points at the
  community's linked chats, which sync as ordinary supergroups and channels.
  If an earlier version turned the community on, the error says that `--auto`
  turns it off and clears its failed jobs (#58).
- A contact removed on Telegram stayed marked as a contact for good, even
  after `tg contacts list --fresh`. The daemon and `--fresh` now unmark it and
  keep the user row (#8).

## [0.4.1] - 2026-10-22

### Changed

- `tg api` no longer passes its own options to Telegram: the one-letter copies
  `j`, `a` and `r` of `--json`, `--account` and `--raw`, and `--verbose`,
  `--quiet`, `--format` and their one-letter forms. A method argument that
  shares a name with one of them (`q` in `contacts.search` and
  `messages.search`, `format` in `account.getThemes`) now goes in `--json`;
  `--q=…` no longer reaches Telegram. API fixtures recorded for `tg api` calls
  need recording again (#68).

### Fixed

- `tg auth login` and `tg auth login-qr` didn't make the account they logged
  in to the one the next command uses. With `activeAccount` in `config.json`,
  the next command went back to the configured account. Without it, a new
  account was marked active next to the old one, and the old one won. A failed
  re-login also switched the active account. A successful login now makes its
  account the only active one and writes its ID to `activeAccount` when
  `config.json` sets that key to another account, as `tg accounts switch`
  does, without ever creating the file. A failed login leaves the active
  account as it was. If that write fails, the login fails with
  `GENERAL_ERROR`, names the account it logged in to (`details.account_id`)
  and keeps the previous active account in both files; make `config.json`
  writable or remove `activeAccount` from it, then run `tg accounts switch
  --id <id>` (#62).
- `tg daemon stop` failed with `DAEMON_SHUTDOWN_TIMEOUT` after its 10-second
  timeout when the daemon was waiting out a FLOOD_WAIT (up to 5 minutes) in
  its dialog pass or a sync job, and the daemon kept running until the wait
  ended. A stop now ends that wait at once: the dialog pass stops as it does
  between dialogs, the sync job goes back to pending with its attempts
  unchanged and is picked up again on the next start, and nothing is logged as
  an error for the request that was cut short (#64).
- `tg api <method> --name value` sent `true` for `name` and dropped `value`,
  so `tg api account.checkUsername --username myuser` failed with
  `TELEGRAM_ERROR` and only `--name=value` worked. Both forms now build the
  same call, a negative number included (`--addOffset -10`, `--geoPoint.lat
  -1.5`). A flag with nothing after it is still `true`, and any other value
  that starts with `-` still needs `--name=value` (#68).
- `tg api <method> --raw` printed the result and then kept running until it
  was killed, so scripts that used `--raw` never finished. It now exits 0
  after printing the result (#69).

## [0.4.0] - 2026-10-22

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
  left out; one whose scheduler fails its startup pass, or whose cache fails
  while its next job is picked, is logged and keeps syncing, and never stops
  the accounts after it. `daemon_status` rows are per account; `tg status` and
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
- Processes that opened a new cache or `data.db` at the same moment, such as
  the daemon and a command right after the first login, could fail with
  "database is locked": SQLite fails all but one switch to WAL at once,
  without waiting. They now try again for up to 5 seconds. The cache moved
  from a shared one is also in this state on its first open.
- Processes that opened a new cache, or one with an outdated search index,
  at the same moment built the index together: one could drop the
  `message_search` table or its triggers while another was filling it, and
  fail with "no such table", "vtable constructor failed" or "database is
  locked". One process now builds it under the write lock while the others
  wait.
- After a reconnect, a complete dialog pass now marks the account's chats it
  didn't list (left, deleted or migrated) caught up, as the startup pass
  does. Before, such a chat whose newest message an earlier failed pass had
  left unknown still cost a `messages.getHistory` call. A chat turned on with
  `tg chats sync` still gets its checking page.
- The daemon could skip a delete in a private chat or basic group, or mark the
  wrong message deleted. Telegram names no chat for such a delete, and the
  daemon matched the ID across every cached chat of the account. When a
  channel or supergroup had a message with the same ID, the deleted message
  stayed unmarked; when the deleted message wasn't cached, that channel post
  was marked deleted instead and dropped out of `tg messages list` and
  `messages search`. The daemon now looks only among the account's private
  chats and basic groups, which share one ID sequence, through a new index on
  `messages_cache.message_id` instead of reading every cached message. An ID
  that two of them still have is left as it is and logged as a warning (#7).
- An account whose first connect failed (login, `getMe` or the updates loop)
  kept its Telegram client, its connection and its session file open until the
  daemon stopped. Stopping the daemon (`tg daemon stop`, SIGTERM or SIGINT)
  also exited without closing any client's connection. The daemon now closes
  each client once, right after a failed connect and on shutdown (#34).
- History pages stored no sender for an incoming private message, a channel
  post or a message in Saved Messages, because Telegram leaves the sender out
  of those, while the same message cached live had one. `fromId` and
  `sender.id` were `null` for them in `tg messages search`, `list` and `get`,
  `sender` had no name, and `--sender` missed them. A daemon catch-up or a
  `--fresh` page also erased the sender that a live update had stored. They
  now get the sender a live message gets: the other user in a private chat,
  your own user in Saved Messages and the channel's marked ID (`-100…`) for a
  channel post. The first run of the new version fills in the messages cached
  before. Stop the daemon before upgrading and start it again after, so the
  old daemon neither loses writes while that one-time fill holds the database
  nor stores new messages without a sender; any it caches after the upgrade
  stay without a sender until they are fetched again (`tg messages list
  --fresh`) (#44).
- A Telegram community (a collection of linked chats) would have been cached
  as a basic group without its access hash, so `tg chats list --type group`
  would have listed it, and syncing it with `tg chats sync` would have reached
  Telegram with access hash 0. The cache now stores a community as type
  `community` with its access hash: `type` in `tg chats` output, `chat_type`
  in `tg status`, and `chats_cache.type` / `chat_sync_state.chat_type` in `tg
  sql` say `community`, `tg chats list --type community` filters on it, and
  like a channel it is off by default. tg doesn't cache joined communities
  yet, because mtcute's dialog list skips them (#58), so `--type community`
  finds none so far (#45).
- `tg status` didn't say when the running daemon was a different version from
  `tg`, so after an upgrade a daemon left running kept writing the cache in
  the old format and nothing said to restart it. The daemon now records its
  version when it starts. `tg status` reports it as `daemon.version` and sets
  `daemon.version_mismatch` when it differs from this `tg` (`cli_version`).
  `--format pretty` shows a Version row and how to restart the daemon, or,
  when the daemon is the newer one, says to use the newer `tg` instead. A
  daemon started by 0.3.0 or older records no version and counts as older
  (#46).
- `tg send --to`, `tg messages list` and `get --chat` took a positive number
  the cache doesn't know as basic group N, so a typo or an uncached user ID
  could send to that group or fail with `PEER_ID_INVALID`. Such a number is
  now user N and never a group: basic group N is `-N`. Without a cached access
  hash Telegram may still refuse the user; use its `@username` or `+phone`
  once and the ID works after that. A number of 10 or more digits is still
  read only as a phone number (#47).
- A daemon stop closed the session files under running clients, so update
  state and peers that arrived between the signal and the shutdown were lost,
  the updates loop logged errors until the process exited, and "Received
  SIGTERM" appeared twice. The daemon now keeps the session files open until
  it closes its clients, so those writes are saved and the stop logs no
  updates-loop error or failed save. A stop during the dialog pass ends it at
  the next dialog; a FLOOD_WAIT the daemon is already waiting out still holds
  the stop until it ends (#64) (#56).
- `tg accounts switch` lasted one command when `config.json` set
  `activeAccount`: the next command made that account active again and read
  its cache. The switch now writes the new ID to `activeAccount` when the key
  is set; without the key `config.json` is not created (#61).
- The startup handling of `config.json` had four more gaps: `-q` skipped
  applying `activeAccount` and the file check that every other format runs, so
  a quiet command could use another account; `-f <format>` before `tg config`
  or `tg skill` ran the check, so `tg config set` couldn't repair an invalid
  file; a file that couldn't be read printed a stack trace instead of a
  `GENERAL_ERROR` with the path in `details.path`; and an invalid file stopped
  `tg daemon start`, though the daemon reads none of its keys (#61).

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

[Unreleased]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/neoromantic/telegram-sync-cli/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/neoromantic/telegram-sync-cli/releases/tag/v0.1.2
