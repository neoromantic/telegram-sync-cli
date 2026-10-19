# telegram-sync-cli

Agent-friendly Telegram Sync CLI with a local cache and full API access. Built on Bun + mtcute.

<img src="docs/images/telegram-sync-cli@2x.png" width="800" alt="A terminal split in two: the top pane shows tg daemon start logging that it bootstrapped 186 dialogs and initialized sync jobs; the bottom pane runs tg messages search --query lisbon piped through jq, column and grep, listing four matches from different chats (Weekend Crew, Ana Ribeiro, Climbing Club, Product Team) with the word Lisbon highlighted">

## Features

- 🧑‍💻 Multi-account management (`tg accounts`, `--account`)
- 🔐 Authentication helpers (`tg auth`)
- 🔄 Read-only daemon for real-time sync + CLI for mutations (`tg daemon`, `tg send`)
- 🧩 Full Telegram API access via `tg api`
- ⚡ Cache-first UX (stale-while-revalidate) with `--fresh`
- ⏱️ Rate-limit tracking for safer API usage
- 🔍 Full-text search (FTS5) over cached messages
- 🗂️ Contacts, chats, and users browsing (`tg contacts`, `tg chats`, `tg me`, `tg user`)
- 🗄️ Read-only SQL access to the cache (`tg sql`) with annotated schema output
- 🧭 Config + status tooling (`tg config`, `tg status`)
- 🤖 Agent-friendly JSON output + stable error schema
- 🧠 Skill integration (`tg skill manifest|validate|install`)
- 🧰 Modern stack: Bun runtime, TypeScript, mtcute

## Documentation

- Getting started: [CLI commands](docs/cli-commands.md), [Authentication](docs/auth.md), [Configuration](docs/configuration.md)
- Architecture & sync: [Architecture](docs/architecture.md), [Daemon](docs/daemon.md), [Sync strategy](docs/sync-strategy.md), [Real-time updates](docs/real-time.md)
- Data & cache: [Caching](docs/caching.md), [Database schema](docs/database-schema.md), [SQL](docs/sql.md), [Search](docs/search.md), [Rate limiting](docs/rate-limiting.md)
- APIs & UX: [API design](docs/api-design.md), [Contacts](docs/contacts.md)
- Build & test: [Build & distribution](docs/build-distribution.md), [Testing](docs/testing.md)

## Quick Start

Requires [Bun](https://bun.sh) >= 1.4.

```bash
bun i -g @goodit/telegram-sync-cli

# Telegram API credentials from https://my.telegram.org/apps
export TELEGRAM_API_ID=123456
export TELEGRAM_API_HASH=your_api_hash

# Log in, then use the cache
tg auth login --phone +15551234567
tg chats list --limit 20 --format pretty
tg messages search --query "hello" --format pretty
```

`tg` runs the TypeScript source with Bun; nothing is compiled at install time.
`npm i -g @goodit/telegram-sync-cli` also works, as long as `bun` is on your
`PATH`. `tg --help` and `tg --version` work before you set any credentials.

## Run from Source

```bash
git clone https://github.com/neoromantic/telegram-sync-cli.git
cd telegram-sync-cli
bun install

# Bun auto-loads .env: fill in TELEGRAM_API_ID and TELEGRAM_API_HASH
cp .env.example .env

bun run src/index.ts auth login --phone +15551234567
bun run src/index.ts contacts list
bun run src/index.ts api account.checkUsername --username myuser

# Or compile the binary to dist/tg
bun run build
```

## Usage

```bash
tg <command> [options]

tg accounts list
tg contacts list --limit 50
tg chats list --limit 20
tg messages search --query "hello"
tg sql --query "SELECT * FROM users_cache LIMIT 10"
tg daemon start
tg status
tg config path
```

Global options: `--format`, `--verbose`, `--quiet`. Many commands also accept `--account`; cache-aware commands accept `--fresh` (see `tg <command> --help`).

## Output Formats

```bash
# JSON (default)
tg contacts list

# Pretty output
tg contacts list --format pretty

# Quiet mode (exit code only)
tg contacts list --format quiet
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_API_ID` | Your Telegram API ID |
| `TELEGRAM_API_HASH` | Your Telegram API Hash |
| `TELEGRAM_SYNC_CLI_DATA_DIR` | Override data directory |
| `MTCUTE_LOG_LEVEL` | mtcute log level |
| `VERBOSE` | Verbose logging (`1`) |

## Development

```bash
# Type check
bun run typecheck

# Unit tests
bun run test

# E2E tests
bun run test:e2e
```

More in [Testing](docs/testing.md) and [Build & distribution](docs/build-distribution.md).
