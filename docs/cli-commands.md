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
| `chats` | list, search (cache-only), get (@username only) |
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
```

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
  "error": { "code": "INVALID_ARGS", "message": "..." }
}
```
