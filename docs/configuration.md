# Configuration

> **Status: Implemented (v0.1.0)** — current configuration system for telegram-sync-cli.

## Overview

The CLI supports an optional JSON config file for app-wide settings such as
active account selection and cache TTLs. Environment variables remain the
source of truth for Telegram API credentials.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `TELEGRAM_API_ID` | Telegram API ID |
| `TELEGRAM_API_HASH` | Telegram API hash |
| `TELEGRAM_PROXY` | Optional proxy URL for CLI and daemon connections |
| `TELEGRAM_SYNC_CLI_DATA_DIR` | Override data directory |
| `MTCUTE_LOG_LEVEL` | mtcute log level |
| `VERBOSE` | Verbose logging (`1`) |

### Proxy

```bash
export TELEGRAM_PROXY=socks5://127.0.0.1:1080
tg daemon start
```

The CLI and daemon use mtcute's URL parser: `socks4://`, `socks5://`, `http://`,
`https://`, and MTProxy links (`tg://proxy?server=…&port=…&secret=…` or
`https://t.me/proxy?server=…&port=…&secret=…`). Credentials go in the URL, for
example `http://user:password@127.0.0.1:8080`. `socks5h://` and addresses without
a scheme are unsupported.

The variable is read only when connecting to Telegram. When unset, connections
use the default direct TCP transport. `ALL_PROXY` and `HTTPS_PROXY` are ignored.
Invalid URLs produce a configuration error (exit code 3 for CLI calls, exit
code 1 on daemon start) without printing the URL. Restart a running daemon
after changing the variable. Keep proxy credentials in the environment, not
`config.json`.

## Storage Layout

Default data directory: `~/.telegram-sync-cli` (override with `TELEGRAM_SYNC_CLI_DATA_DIR`).

```
~/.telegram-sync-cli/
├── data.db            # Accounts table
├── cache.db           # Cache + sync tables
├── session_<id>.db    # mtcute session per account
├── daemon.pid         # PID file when daemon is running
└── config.json        # User config
```

## Configuration File

**Path:** `<dataDir>/config.json` where `dataDir` is `TELEGRAM_SYNC_CLI_DATA_DIR` or
`~/.telegram-sync-cli`.

Supported keys:

- `activeAccount` (number)
- `cache.staleness.peers` (duration)
- `cache.staleness.dialogs` (duration)
- `cache.staleness.fullInfo` (duration)
- `cache.backgroundRefresh` (boolean)
- `cache.maxCacheAge` (duration)

Duration format: `<number><unit>` with units `s`, `m`, `h`, `d`, `w`
(case-insensitive). Values are normalized to lowercase (e.g., `7D` → `7d`).

Example:

```json
{
  "activeAccount": 1,
  "cache": {
    "staleness": {
      "peers": "7d",
      "dialogs": "1h",
      "fullInfo": "7d"
    },
    "backgroundRefresh": true,
    "maxCacheAge": "30d"
  }
}
```

Unknown keys are ignored. Invalid values produce errors when running commands
that require strict config validation.

## CLI Commands

```bash
tg config path
tg config get <key>
tg config set <key> <value>
```

Examples:

```bash
tg config get cache.staleness.peers
tg config set cache.staleness.peers 3d
tg config set activeAccount 2
```

## Runtime Behavior

- On startup (except for `tg config`), the CLI reads `activeAccount` and switches
  the active account if it exists.
- Cache-related commands resolve TTLs via `config.json` overrides.
- Config errors are surfaced as `INVALID_ARGS` with issue details.

## Validation

- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are required.
- Missing credentials fail fast with actionable errors.

## Security

- Treat `session_<id>.db`, `data.db`, and `cache.db` as sensitive.
- Do not embed API credentials in compiled binaries.
