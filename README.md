# telegram-sync-cli

Agent-friendly Telegram CLI with a local cache, a read-only sync daemon and full MTProto API access.

[![CI](https://github.com/neoromantic/telegram-sync-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/neoromantic/telegram-sync-cli/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@goodit/telegram-sync-cli)](https://www.npmjs.com/package/@goodit/telegram-sync-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

<img src="docs/images/telegram-sync-cli@2x.png" width="800" alt="A terminal split in two: the top pane shows tg daemon start logging that it bootstrapped 186 dialogs and initialized sync jobs; the bottom pane runs tg messages search --query lisbon piped through jq, column and grep, listing four matches from different chats (Weekend Crew, Ana Ribeiro, Climbing Club, Product Team) with the word Lisbon highlighted">

## Install

Requires [Bun](https://bun.sh) >= 1.4.

```bash
bun i -g @goodit/telegram-sync-cli
```

`tg` runs the TypeScript source with Bun; nothing is compiled at install time.
`npm i -g @goodit/telegram-sync-cli` also works, as long as `bun` is on your `PATH`.

From source:

```bash
git clone https://github.com/neoromantic/telegram-sync-cli.git
cd telegram-sync-cli
bun install
bun run src/index.ts --help   # or: bun run build, then ./dist/tg
```

## Quickstart

```bash
# Telegram API credentials from https://my.telegram.org/apps
export TELEGRAM_API_ID=123456
export TELEGRAM_API_HASH=your_api_hash

tg auth login --phone +15551234567   # or: tg auth login-qr
tg chats list --limit 20 --format pretty
tg daemon start                      # keep the cache in sync (foreground)
tg messages search --query "hello" --format pretty
```

`tg --help` and `tg --version` work before you set any credentials. When running from source,
Bun auto-loads `.env`, so you can `cp .env.example .env` and fill it in instead.

## Features

- Multi-account management (`tg accounts`, `--account`)
- Phone and QR login (`tg auth`)
- Read-only daemon for real-time sync and history backfill; the CLI does all mutations (`tg send`)
- Full Telegram API access through `tg api <method>`
- Cache-first reads (stale-while-revalidate) with `--fresh` to bypass the cache
- Full-text search (FTS5) over cached messages
- Contacts, chats and users (`tg contacts`, `tg chats`, `tg me`, `tg user`)
- Read-only SQL over the cache (`tg sql`) with an annotated schema
- Rate-limit tracking, config and status tooling (`tg config`, `tg status`)
- JSON output and a stable error schema for scripts and agents

## Usage

```bash
tg <command> [options]

tg accounts list
tg contacts list --limit 50
tg chats list --limit 20
tg messages search --query "hello"
tg send --to @username --message "Hi there"
tg api account.checkUsername --username myuser
tg sql --query "SELECT * FROM users_cache LIMIT 10"
tg daemon start
tg status
tg config path
```

Global options: `--format json|pretty|quiet`, `--verbose`, `--quiet`. Many commands accept
`--account`; cache-aware commands accept `--fresh`. See `tg <command> --help`.

| Variable | Description |
|----------|-------------|
| `TELEGRAM_API_ID` | Your Telegram API ID |
| `TELEGRAM_API_HASH` | Your Telegram API hash |
| `TELEGRAM_SYNC_CLI_DATA_DIR` | Override the data directory (default `~/.telegram-sync-cli`) |
| `MTCUTE_LOG_LEVEL` | mtcute log level |
| `VERBOSE` | Verbose logging (`1`) |

Reference: [CLI commands](docs/cli-commands.md), [authentication](docs/auth.md),
[configuration](docs/configuration.md), [architecture](docs/architecture.md),
[daemon](docs/daemon.md), [sync strategy](docs/sync-strategy.md), [caching](docs/caching.md),
[database schema](docs/database-schema.md), [SQL](docs/sql.md), [search](docs/search.md),
[rate limiting](docs/rate-limiting.md). Known gaps are tracked in
[issues](https://github.com/neoromantic/telegram-sync-cli/issues).

## For AI agents

- Output is JSON by default. Errors look like
  `{"success": false, "error": {"code": "RATE_LIMITED", "message": "…", "details": {"wait": 30}, "suggestion": "…"}}`.
- Exit codes: `0` ok, `1` general error, `2` auth required, `3` invalid arguments,
  `4` network error, `5` Telegram error or rate limit, `6` account not found.
- `tg sql --query "…"` runs read-only SQL over the cache; `tg sql print-schema` prints the
  annotated schema.
- `tg skill manifest` prints a skill manifest, `tg skill validate` checks the environment and
  `tg skill install` writes the manifest to the default location.
- The daemon never sends or edits anything, so it is safe to leave running.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md). Security issues:
[SECURITY.md](SECURITY.md). License: [MIT](LICENSE).
