# CLI Commands

> **Status: Implemented**
>
> This document summarizes current CLI behavior. For exact flags, use `tg <command> --help`.

## Command Index

| Command | Notes |
|---------|-------|
| `auth` | login, login-qr, logout, status |
| `accounts` | list, switch, remove, info |
| `contacts` | list, search, get (cached; supports `--fresh`) |
| `chats` | list, search (cache-only), get (@username only), sync (cache-only) |
| `messages` | list, get (cache-first, `--fresh`), search (FTS5, cache-only) |
| `send` | send messages (`--to`, `--message`) |
| `api` | raw Telegram API calls |
| `me` | current user |
| `user` | user lookup |
| `status` | system status |
| `daemon` | start/stop/status |
| `db` | vacuum: prune an account's cache and give its free space back to the disk |
| `sql` | read-only cache queries |

## Global Flags

Available on the root command:

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--format` | `-f` | Output format: `json`, `pretty`, `quiet` | `json` |
| `--verbose` | `-v` | Verbose logging | Off |
| `--quiet` | `-q` | Minimal output | Off |

> `--account` and `--fresh` are **per-command** options where supported. `--account` accepts an ID, `@username`, or label,
> and picks the account whose cache the command reads and writes: each account has its own,
> `accounts/<id>/cache.db`. Without it a command uses the active account, else the only one;
> see [configuration.md](configuration.md#which-account-a-command-uses) for the errors.

## Core Commands

### Authentication

```bash
tg auth login --phone +15551234567
tg auth login-qr
tg auth logout
tg auth status
```

### Accounts

```bash
tg accounts list
tg accounts switch --id 1
tg accounts remove --id 1
tg accounts info --id 1
```

### Contacts

```bash
tg contacts list --limit 50 --offset 0
tg contacts search --query "John"
tg contacts get --id @username
```

### Chats

```bash
tg chats list --type private --limit 50
tg chats search --query "team"   # cache-only
tg chats get --id @username       # or the ID of a cached chat (cache-only, no credentials)
tg chats sync @examplenews        # sync this chat in the background
```

`--type` takes `private`, `group`, `supergroup`, `channel` or `community` (a Telegram
community, a collection of linked chats). `--type community` lists the communities the
account joined once a daemon start or `tg chats list --fresh` has cached them.

`tg chats get --id` reads an ID like `tg chats sync` does. A bare 0.2.0 ID that names both a
cached basic group and a cached channel is `INVALID_ARGS` (exit 3) with
`details: { identifier, candidates }`.

### Chat sync

The daemon syncs DMs and groups of up to 100 members by default. Archived ones start when a
message arrives in them live, or with `tg chats sync`. A community has no messages of its own,
so `tg chats sync <community>` refuses to turn it on (see the errors below); the chats linked to
it are ordinary supergroups and channels and sync as such. Groups of unknown size or over 100
members and channels get catch-up and history only on request:

```bash
tg chats sync @examplenews        # turn sync on
tg chats sync -1001234567890      # the ID tg chats list shows (-100… for channels, -N for basic groups)
tg chats sync 1234567890          # the bare ID 0.2.0 showed works too
tg chats sync @examplenews --off  # stop catch-up and history for it
tg chats sync @examplenews --auto # follow the default policy again
```

- The choice is stored in `chat_sync_state.sync_mode` and kept across daemon restarts and
  dialog passes.
- `--off` and the default policy control catch-up, first pages and history. While the daemon
  runs, it caches messages that arrive live in every chat, including one that is off.
- `id` and `peerId` are the same marked ID; `peerId` stays for scripts written against 0.2.0,
  where `id` was the bare one. A positive ID is a user's DM first, as in `tg send --to`: the
  bare group or channel ID counts only when the cache doesn't know user N. A bare ID that names
  both a cached basic group and a cached channel is `INVALID_ARGS` (exit 3) with
  `details: { chat, candidates }`, `candidates` being both marked IDs.
- Cache-only: the chat must be in `chats_cache` or have sync state from the daemon. No Telegram
  credentials needed. A daemon start caches every chat, archived ones and joined communities
  too; `tg chats get --id @username` caches one chat; `tg chats list --fresh` caches the 200
  newest dialogs that aren't archived and every joined community.
- A chat that isn't found fails with `INVALID_ARGS` (exit 3) and the suggestion to start the
  daemon or run `tg chats get --id @username`. `--off` with `--auto` is `INVALID_ARGS` too.
- Turning on a community (no flag) is `INVALID_ARGS` (exit 3) with
  `details: { chat, id, type: 'community', account_id }` and a suggestion that points at its
  linked supergroups and channels. The command writes nothing and queues no jobs. `--off` and
  `--auto` still work: they match the default policy, which leaves a community off. If an
  earlier version turned the community on, the suggestion also says that `--auto` turns it off
  and clears its failed jobs.
- A running daemon applies the change at its next refresh (30 seconds or less). A chat turned
  on gets its first page ahead of other first pages. A changed mode cancels the chat's pending
  jobs; a job that is running finishes.
- In any mode, and even when the mode didn't change, the command deletes the chat's failed
  sync jobs (`clearedFailedJobs` counts them). A failed job keeps the daemon from queueing its
  chat again until it is cleaned up a day later, so running the command again with the chat's
  current mode retries it at the next refresh: `--auto` for a chat that follows the policy (the
  default), no flag for one turned on. Without a flag the command turns the chat on.
  `tg status` prints the command for each failed job.
- `--account` picks the account whose sync state changes; another account's chats aren't in
  its cache, so the command reports them as not found (`details.account_id` names the account).
- A chat you haven't joined, such as a public channel cached by `tg chats get --id @username`,
  gets its first page and history, but new messages only on daemon start and after reconnects:
  Telegram sends no live updates for it.

```json
{
  "success": true,
  "data": {
    "id": -1001234567890,
    "peerId": -1001234567890,
    "type": "channel",
    "title": "Example News",
    "username": "examplenews",
    "mode": "on",
    "syncEnabled": true,
    "historyComplete": false,
    "syncedMessages": 0,
    "changed": true,
    "clearedFailedJobs": 0
  }
}
```

### Messages

```bash
tg messages list --chat @username                  # the newest 20, newest first
tg messages list --chat @username --before 1200    # the page older than message 1200
tg messages list --chat -1001234567890 --after 0   # from the first message on
tg messages list --chat me --limit 5 --fresh       # from Telegram, then cached
tg messages get --chat @username --id 1200 --context 3   # 3 newer and 3 older around it
tg messages search --query "hello"
tg messages search --query "hello" --chat @teamchat --sender @alice
tg messages search --query "hello" --includeDeleted
```

`tg messages list` reads one chat, newest first. `--chat` takes the same forms as `tg send --to`:
`@username`, a user or chat ID as `tg chats list` or `tg messages search` prints it, a phone
number with `+`, or `me`. A bare 0.2.0 ID that names both a cached basic group and a cached
channel is `INVALID_ARGS` (exit 3) with `details: { chat, candidates }` in `list` and `get`.
To page back, pass `nextBefore` as `--before`; to page forward, pass `nextAfter` as `--after`;
stop when `items` is empty. Both bounds are exclusive message IDs, `--after 0` starts at the
first message, and with both set the page is the one right after `--after`. `--limit` is 1-100
(default 20).

```json
{ "chatId": -1001234567890, "items": [ … ], "limit": 20, "before": null, "after": null,
  "nextBefore": 1181, "nextAfter": 1200, "source": "cache", "stale": false }
```

The cache answers when it holds the whole window without a gap: every page the daemon or `tg`
caches records the message IDs it covers, and the cache serves a window only inside one such
range, when that range holds `--limit` messages of it or reaches the chat's first message
(paging back) or `--before` (paging forward). Otherwise `tg` fetches that window from Telegram,
caches it and returns `source: "api"`, which needs credentials and a connection. So a page
never skips messages the cache lacks, and a short page past the newest cached message, such as
the last one when paging forward, asks Telegram. Messages that live updates or `tg send` cached
are read from Telegram until a page covers them, so while the daemon runs, the newest page of an
active chat asks Telegram. The newest page comes from the cache when a range holds it, so
without a running daemon it can miss recent messages. See
[caching.md](caching.md#chat-history). `--fresh` always reads the window from Telegram.

`tg messages get` returns one message with up to `--context` messages (0-49, default 0) on each
side: `{ chatId, message, newer, older, source, stale }`. `newer` and `older` are newest first,
so `[...newer, message, ...older]` reads like a `list` page. The cache answers when it holds the
message and, with `--context`, each side whole, as `list` would serve that side next to the
message. Otherwise one call fetches the message with both sides, caches them and returns
`source: "api"`. So the context of a chat's newest message always asks Telegram. The context of
a cached deleted message comes from the cache as its ranges hold it. If the message is cached
and that call fails (no credentials or connection, a flood wait, a chat Telegram refuses) or
Telegram no longer returns the message, the cached message comes back with the context the
cache holds and `source: "cache"`, so a cached search hit always opens (`--verbose` logs the
error). `--fresh` fetches all of it from Telegram and reports a failed call. A missing message
is a `TELEGRAM_ERROR` with `details: { chatId, messageId }`. A deleted message that is cached is
returned with `isDeleted: true`.

Items are exactly the objects `tg messages search` prints. Deleted messages are left out unless
`--includeDeleted` is set.

### Send

```bash
tg send --to @username --message "Hello"
tg send --to @username -m "Reply" --reply-to 123
tg send --to me -m "Note to self"   # Saved Messages
tg send --to -1001234567890 -m "Hi" # a chat ID as tg messages search prints it
```

`--to` takes an `@username`, a user or chat ID as any `tg` command prints it (`tg chats list`,
`tg messages search` and `tg sql` print the same marked IDs: `-100…` for channels and
supergroups, `-N` for basic groups, the user ID for a private chat), a phone number with `+`
(spaces, dashes and brackets are fine), or `me`. The bare group or channel ID that 0.2.0
printed still works when the cache knows the chat; if it names both a cached basic group and a
cached channel, the command fails with `INVALID_ARGS` (exit 3) and
`details: { to, candidates }`, `candidates` being both marked IDs.

A positive number the cache doesn't know is a user ID, never a basic group (basic group N is
`-N`). `tg` has no access hash for that user, so Telegram may refuse it. An uncached number with
10 or more digits is read only as a phone number, and the command fails if no account has it.
Send to the user's `@username` or `+phone` once: `tg` caches the user, and its ID works after
that, whatever its length.

A sent message goes into the message cache right away, so `tg messages search`
finds it without the daemon.

### API

```bash
tg api account.checkUsername --username myuser
tg api messages.getHistory --peer @username --limit 10
tg api messages.sendMessage --json '{"peer":"@user","message":"Hi"}'
```

### Daemon / Status / SQL

```bash
tg daemon start
tg daemon stop --timeout 10
tg daemon status

tg status
tg status --account work        # only this account's figures
tg status --sizes               # add each table's size (reads the whole cache)

tg sql --query "SELECT * FROM users_cache LIMIT 10"
tg sql --query "SELECT COUNT(*) AS n FROM messages_cache" --account 2
tg sql print-schema --table=users_cache
tg sql print-schema --table=users_cache --output=sql  # Annotated DDL
```

`tg status` reads every account's cache, so it works without Telegram credentials and needs no
active account; it never creates a cache. Its totals are sums over the accounts. Its `sync`
part counts the daemon's sync jobs and lists some of them:

- `pending_jobs` includes the jobs waiting for a retry, `running_jobs`, `failed_jobs` (jobs that
  failed for good) and `retrying_jobs` (pending jobs that failed at least once).
- `jobs` lists, for each account in ID order, the running jobs, the next 5 pending ones and the
  5 newest failed ones, each with `account_id` (whose cache holds it), `attempts`, `error` (the last error, or `null`), `next_run_at` (when a waiting job runs
  again, or `null` if it is due) and `sync_mode` (the chat's mode, or `null` if the chat has no
  sync state).
- A failed job is retried after `cache.retention.failedJobs` (24 hours by default) or a daemon
  restart. `tg chats sync <chat_id>` with
  the flag of its `sync_mode` (`--auto` for `auto`, none for `on`) deletes the chat's failed
  jobs, so a running daemon retries them at its next refresh (30 seconds or less). Without a
  flag the command turns an `auto` chat on. `--format pretty` shows the same, with a Retrying
  and a Failed row and the command for each chat with a failed job. With several accounts each
  job line carries `acct:<id>` and the command adds `--account <id>`.
- `progress.sample_chats` (the overall top 5) and `rate_limits.active_flood_waits` items carry
  `account_id` too.
- `accounts.accounts[]` gives each account its own figures: `cache` (`status`: `ok`,
  `missing` for an account with no cache yet, which `tg status` never creates, or `error` with
  `error` for a cache that fails to open or to answer a query; its figures are then zero and
  the other accounts still report), `connection` (`{ status, last_error }` from a live daemon, else `null`), `sync`
  (`pending_jobs`, `running_jobs`, `failed_jobs`, `retrying_jobs`), `progress`
  (`chats_enabled`, `chats_history_complete`, `chats_history_pending`, `messages_cached`) and
  `rate_limits` (`api_calls_last_minute`, `active_flood_waits`, a count). With several
  accounts, pretty output prints a line with these under each account.
- `accounts.accounts[].cache.size` is the cache's size, or `null` for a missing cache or one
  that failed: `file_bytes` (the database file), `wal_bytes` (its `-wal` file, 0 when there is
  none), `page_size`, `page_count`, `free_pages` and `free_bytes` (pages inside the file that
  hold no data, which `tg db vacuum` gives back to the disk) and `auto_vacuum` (`none`, `full`
  or `incremental`). With `--sizes` it adds `tables`: bytes per table, its indexes and FTS5
  shadow tables counted with it (`message_search` holds the search index), or `null` when
  SQLite has no `dbstat`. `--sizes` reads every page of the cache, which on a large cache
  read cold from disk takes a while, so plain `tg status` leaves it out. Pretty output shows a
  Cache Size section with a line per account (the total, the WAL, the free space and, with
  `--sizes`, the three largest tables) and the `tg db vacuum --account <id>` command for each
  account whose free pages are over 10% of its file.
- `--account <selector>` scopes the totals, the lists and `accounts.accounts` to one account;
  `account_id` says which (`null` without the flag). The `daemon` section always covers the
  whole daemon, and `accounts.total` and the `active_*` fields stay those of every account.
  Pretty output says which account the figures cover in a line under the title, and still
  prints that account's line.
- `storage.cache_bytes` is the sum of `file_bytes` and `wal_bytes` over the accounts in scope
  (only `--account`'s with the flag).
- `storage` also reports the shared cache of 0.3 and older: `legacy_caches` lists the files set
  aside as `shared-cache*.db` (`path`, `size_bytes`), and `migration` is `null` or
  `{ reason, path, suggestion }` while the move waits (see
  [configuration.md](configuration.md#upgrading-to-per-account-caches)). Pretty output shows a
  Storage section only when there is something in it. `tg daemon status` of a running daemon
  returns the same `storage`, without `cache_bytes` (see [daemon.md](daemon.md#status-output)).

```json
{
  "pending_jobs": 1,
  "running_jobs": 0,
  "failed_jobs": 1,
  "retrying_jobs": 1,
  "jobs": [
    {
      "account_id": 1,
      "id": 41,
      "chat_id": 1234567890,
      "type": "backward_history",
      "status": "pending",
      "messages_fetched": 0,
      "attempts": 2,
      "error": "connection reset",
      "next_run_at": "2026-01-01T00:04:00.000Z",
      "sync_mode": "auto"
    },
    {
      "account_id": 1,
      "id": 42,
      "chat_id": -1001234567890,
      "type": "initial_load",
      "status": "failed",
      "messages_fetched": 0,
      "attempts": 1,
      "error": "Telegram API error 400: CHANNEL_PRIVATE",
      "next_run_at": null,
      "sync_mode": "auto"
    }
  ]
}
```

The `daemon` part of `tg status` says which version the running daemon is, so you can tell
when it needs a restart after an upgrade:

- `daemon.version` is the version the running daemon recorded in the accounts' caches when it
  started. It is `null` when the daemon is stopped or still starting.
- `daemon.version_mismatch` is `true` when a running daemon's version differs from
  `cli_version`, or when its rows record none. It is `false` while the daemon is stopped or
  still starting.
- A daemon of tg 0.3 or older writes nothing to `accounts/<id>/cache.db`, so it reads as still
  starting (`version` `null`, `version_mismatch` `false`). While it holds the shared cache of
  that version, `storage.migration` says so (`shared_cache_in_use`) and to stop it.
- `cli_version` is this tg's version.
- A daemon keeps the code it started with, so after an upgrade restart it (`tg daemon stop`,
  then `tg daemon start`). If `version` is newer than `cli_version`, this tg is the older
  install: use the newer one rather than restarting the daemon with this one.
- `--format pretty` shows a Version row and the same advice.

```json
{
  "daemon": {
    "status": "running",
    "pid": 4242,
    "version": "0.3.1",
    "version_mismatch": true,
    "uptime_seconds": 86400,
    ...
  },
  ...
  "cli_version": "0.3.2"
}
```

### Cache maintenance

```bash
tg db vacuum                    # the active account's cache
tg db vacuum --account 2
```

`tg db vacuum` works on one account's cache (`--account`, else the active account, else the
only one) and needs no Telegram credentials. It first prunes the bookkeeping tables by
`cache.retention.*`, as the daemon does ([daemon.md](daemon.md#cache-pruning)), so it prunes
without a daemon too, then gives the cache's free pages back to the disk:

- **`full`**, while the daemon is stopped: a `VACUUM` rewrites the file without its free pages
  and switches it to incremental auto_vacuum. It waits up to a minute for another process's
  write lock. A VACUUM may renumber the rows of `messages_cache`; if it did, the search index is
  rebuilt. Don't start the daemon while it runs: the daemon would wait for the rewrite.
- **`incremental`**, while the daemon runs, on a cache with incremental auto_vacuum (every cache
  this version creates, and every one that had a full vacuum): the free pages are released in
  steps of 1,024 pages, each a short write, so the daemon keeps writing in between.
- A cache of an older version, without auto_vacuum, needs one full vacuum: while the daemon
  runs the command fails with `DAEMON_ALREADY_RUNNING` (exit 1), `details`
  `{ account_id, auto_vacuum: "none" }` and the suggestion
  `tg daemon stop && tg db vacuum && tg daemon start`, and changes nothing.
- **`skipped`**: the account has no cache file yet; none is created.

Both modes end with a checkpoint that empties the WAL (`checkpointed: false` when another
process was reading it; the next checkpoint empties it). While the daemon runs, the checkpoint
never waits for a reader, so it doesn't hold up the daemon's writes. A full vacuum needs free disk space of
about twice the cache: a copy of it in the temporary directory and a WAL as big as the cache.
Output:

```json
{
  "account_id": 1,
  "mode": "full",
  "bytes_before": 52428800,
  "bytes_after": 31457280,
  "freed_bytes": 20971520,
  "free_pages_after": 0,
  "auto_vacuum": "incremental",
  "pruned": { "api_activity": 1200, "rate_limits": 40, "completed_jobs": 12, "failed_jobs": 0 },
  "checkpointed": true
}
```

`bytes_before` and `bytes_after` count the file and its WAL. Errors: `GENERAL_ERROR` with
`details.reason` `cache_busy` when another process held the write lock past the wait (try again),
or `disk_full` when the disk filled up during the VACUUM (the cache is unchanged; free space
first).

## Output Shape

All commands use a consistent wrapper in JSON mode:

```json
{
  "success": true,
  "data": { ... }
}
```

Errors:

```json
{
  "success": false,
  "error": { "code": "INVALID_ARGS", "message": "...", "details": {}, "suggestion": "..." }
}
```

`details` and `suggestion` are optional.
