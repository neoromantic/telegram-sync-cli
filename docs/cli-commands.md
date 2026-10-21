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
| `messages` | search (FTS5, cache-only) |
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

The daemon syncs DMs and groups of up to 100 members by default. Groups of unknown size or
over 100 members and channels sync only on request:

```bash
tg chats sync @examplenews        # turn sync on
tg chats sync 1234567890          # the ID that tg chats list shows
tg chats sync -1001234567890      # or a marked ID (-100… for channels, -N for basic groups)
tg chats sync @examplenews --off  # stop syncing it
tg chats sync @examplenews --auto # follow the default policy again
```

- The choice is stored in `chat_sync_state.sync_mode` and kept across daemon restarts and
  dialog passes.
- Cache-only: the chat must be in `chats_cache` (`tg chats list --fresh` or a daemon start puts
  it there) or have sync state from the daemon. No Telegram credentials needed.
- A chat that isn't found fails with `INVALID_ARGS` (exit 3) and the suggestion to run
  `tg chats list --fresh` or start the daemon. `--off` with `--auto` is `INVALID_ARGS` too.
- A running daemon applies the change at its next refresh (30 seconds or less). A chat turned
  on gets its first page ahead of other first pages. A changed mode cancels the chat's pending
  jobs; a job that is running finishes.
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
    "changed": true
  }
}
```

### Messages

```bash
tg messages search --query "hello"
tg messages search --query "hello" --chat @teamchat --sender @alice
tg messages search --query "hello" --includeDeleted
```

### Send

```bash
tg send --to @username --message "Hello"
tg send --to @username -m "Reply" --reply-to 123
tg send --to me -m "Note to self"   # Saved Messages
```

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
