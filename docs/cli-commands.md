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
| `sql` | read-only cache queries |

## Global Flags

Available on the root command:

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--format` | `-f` | Output format: `json`, `pretty`, `quiet` | `json` |
| `--verbose` | `-v` | Verbose logging | Off |
| `--quiet` | `-q` | Minimal output | Off |

> `--account` and `--fresh` are **per-command** options where supported. `--account` accepts an ID, `@username`, or label.

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
community, a collection of linked chats). tg doesn't cache joined communities yet
([#58](https://github.com/neoromantic/telegram-sync-cli/issues/58)), so `--type community`
finds none so far.

`tg chats get --id` reads an ID like `tg chats sync` does. A bare 0.2.0 ID that names both a
cached basic group and a cached channel is `INVALID_ARGS` (exit 3) with
`details: { identifier, candidates }`.

### Chat sync

The daemon syncs DMs and groups of up to 100 members by default. Archived ones start when a
message arrives in them live, or with `tg chats sync`. A community is off by default; the chats
linked to it are ordinary supergroups and channels and sync as such. Groups of unknown size or
over 100 members and channels get catch-up and history only on request:

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
  credentials needed. A daemon start caches every chat, archived ones too (communities not yet,
  #58); `tg chats get --id @username` caches one chat; `tg chats list --fresh` caches only the
  200 newest dialogs that aren't archived.
- A chat that isn't found fails with `INVALID_ARGS` (exit 3) and the suggestion to start the
  daemon or run `tg chats get --id @username`. `--off` with `--auto` is `INVALID_ARGS` too.
- A running daemon applies the change at its next refresh (30 seconds or less). A chat turned
  on gets its first page ahead of other first pages. A changed mode cancels the chat's pending
  jobs; a job that is running finishes.
- In any mode, and even when the mode didn't change, the command deletes the chat's failed
  sync jobs (`clearedFailedJobs` counts them). A failed job keeps the daemon from queueing its
  chat again until it is cleaned up a day later, so running the command again with the chat's
  current mode retries it at the next refresh: `--auto` for a chat that follows the policy (the
  default), no flag for one turned on. Without a flag the command turns the chat on.
  `tg status` prints the command for each failed job.
- `--account` is checked like in `chats search`; all accounts share one cache.
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

tg sql --query "SELECT * FROM users_cache LIMIT 10"
tg sql print-schema --table=users_cache
tg sql print-schema --table=users_cache --output=sql  # Annotated DDL
```

`tg status` reads the cache, so it works without Telegram credentials. Its `sync` part counts
the daemon's sync jobs and lists some of them:

- `pending_jobs` includes the jobs waiting for a retry, `running_jobs`, `failed_jobs` (jobs that
  failed for good) and `retrying_jobs` (pending jobs that failed at least once).
- `jobs` lists the running jobs, the next 5 pending ones and the 5 newest failed ones, each with
  `attempts`, `error` (the last error, or `null`), `next_run_at` (when a waiting job runs
  again, or `null` if it is due) and `sync_mode` (the chat's mode, or `null` if the chat has no
  sync state).
- A failed job is retried after 24 hours or a daemon restart. `tg chats sync <chat_id>` with
  the flag of its `sync_mode` (`--auto` for `auto`, none for `on`) deletes the chat's failed
  jobs, so a running daemon retries them at its next refresh (30 seconds or less). Without a
  flag the command turns an `auto` chat on. `--format pretty` shows the same, with a Retrying
  and a Failed row and the command for each chat with a failed job.

```json
{
  "pending_jobs": 1,
  "running_jobs": 0,
  "failed_jobs": 1,
  "retrying_jobs": 1,
  "jobs": [
    {
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

- `daemon.version` is the version the running daemon recorded when it started. It is `null`
  when the daemon is stopped, still starting, or was started by tg 0.3.0 or older, which record
  none.
- `daemon.version_mismatch` is `true` when a running daemon's version differs from
  `cli_version` or it recorded none.
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
    "version": "0.3.0",
    "version_mismatch": true,
    "uptime_seconds": 86400,
    ...
  },
  ...
  "cli_version": "0.3.1"
}
```

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
