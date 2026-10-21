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
tg chats get --id @username       # username only
tg chats sync @examplenews        # sync this chat in the background
```

### Chat sync

The daemon syncs DMs and groups of up to 100 members by default. Archived ones start when a
message arrives in them live, or with `tg chats sync`. Groups of unknown size or over 100
members and channels get catch-up and history only on request:

```bash
tg chats sync @examplenews        # turn sync on
tg chats sync 1234567890          # the ID that tg chats list shows
tg chats sync -1001234567890      # or a marked ID (-100… for channels, -N for basic groups)
tg chats sync @examplenews --off  # stop catch-up and history for it
tg chats sync @examplenews --auto # follow the default policy again
```

- The choice is stored in `chat_sync_state.sync_mode` and kept across daemon restarts and
  dialog passes.
- `--off` and the default policy control catch-up, first pages and history. While the daemon
  runs, it caches messages that arrive live in every chat, including one that is off.
- Cache-only: the chat must be in `chats_cache` or have sync state from the daemon. No Telegram
  credentials needed. A daemon start caches every chat, archived ones too;
  `tg chats get --id @username` caches one chat; `tg chats list --fresh` caches only the 200
  newest dialogs that aren't archived.
- A chat that isn't found fails with `INVALID_ARGS` (exit 3) and the suggestion to start the
  daemon or run `tg chats get --id @username`. `--off` with `--auto` is `INVALID_ARGS` too.
- A running daemon applies the change at its next refresh (30 seconds or less). A chat turned
  on gets its first page ahead of other first pages. A changed mode cancels the chat's pending
  jobs; a job that is running finishes.
- In any mode, and even when the mode didn't change, the command deletes the chat's failed
  sync jobs (`clearedFailedJobs` counts them). A failed job keeps the daemon from queueing its
  chat again until it is cleaned up a day later, so running `tg chats sync <chat>` again
  retries it at the next refresh.
- `--account` is checked like in `chats search`; all accounts share one cache.
- A chat you haven't joined, such as a public channel cached by `tg chats get --id @username`,
  gets its first page and history, but new messages only on daemon start and after reconnects:
  Telegram sends no live updates for it.

```json
{
  "success": true,
  "data": {
    "id": 1234567890,
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
number with `+`, or `me`. To page back, pass `nextBefore` as `--before`; to page forward, pass
`nextAfter` as `--after`; stop when `items` is empty. Both bounds are exclusive message IDs,
`--after 0` starts at the first message, and with both set the page is the one right after
`--after`. `--limit` is 1-100 (default 20).

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

`--to` takes an `@username`, a user or chat ID (raw, as `tg chats list` prints it, or marked,
as `tg messages search` and `tg sql` print it: `-100…` for channels and supergroups, `-N` for
basic groups), a phone number with `+` (spaces, dashes and brackets are fine), or `me`.

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
