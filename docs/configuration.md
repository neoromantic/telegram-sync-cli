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
├── data.db              # Accounts table
├── session_<id>.db      # mtcute session per account
├── accounts/<id>/       # One directory per account (mode 0700)
│   └── cache.db         # The account's cache, sync state, jobs and rate limits
├── daemon.pid           # PID file when daemon is running
└── config.json          # User config
```

Each account's data lives in its own `accounts/<id>/cache.db`, where `<id>` is the ID that
`tg accounts list` prints. Back up or delete one account by its directory.
`tg accounts remove` and `tg auth logout` keep `accounts/<id>/`; delete the directory to drop
that account's cache. Table layouts: [database-schema.md](database-schema.md).

Logging in again after `tg auth logout` (or `tg accounts remove`) gives the same Telegram user
a new account ID, and that account starts an empty cache: tg doesn't pick the old directory up
by itself. To keep the old cache, stop the daemon, delete the new `accounts/<new-id>/` if it
exists, and rename `accounts/<old-id>/` to `accounts/<new-id>/`. tg takes it on the next open,
because the file is stamped for the same Telegram user and its old account ID is gone. A cache
stamped for another Telegram user is refused with `CACHE_UNAVAILABLE` (`owner_mismatch`).

### Which account a command uses

Every command that reads or writes a cache works on one account:

1. the account `--account` selects (ID, `@username` or label);
2. otherwise the active account: the one `tg accounts switch --id <id>` or the last successful
   `tg auth login` or `login-qr` made active. When `config.json` sets `activeAccount`, that
   value wins at the start of every command, and `tg accounts switch` and a successful login
   update it; see [Runtime Behavior](#runtime-behavior);
3. otherwise the only account, if there is exactly one.

With no account, cache commands fail with `AUTH_REQUIRED` (exit 2). With several accounts and
none active they fail with `NO_ACTIVE_ACCOUNT` (exit 1); `error.details.accounts` lists them.
`tg status` and `tg sql print-schema` need no account.

### Upgrading to per-account caches

Up to 0.3 every account shared one `cache.db` at the root of the data directory. Stop the
daemon of the older version (`tg daemon stop`) before upgrading. The first command that needs a
cache moves the old file. The move decides by how many accounts there are, so `tg auth login`,
`tg auth login-qr`, `tg auth logout` and `tg accounts remove` also move it first, before they
change the accounts; `tg accounts list`, `tg config`, `tg daemon stop`, `--help` and
`--version` leave it alone:

- **One account**: the file becomes `accounts/<id>/cache.db`. Every message, cursor, job and
  rate limit carries over, and nothing is synced again.
- **Several accounts** (or none): the old file's rows can't be split by account, so it is set
  aside as `shared-cache.db` (`shared-cache-2.db`, … if that name is taken) and each account
  starts an empty cache that the daemon fills again. One line on stderr says where the file
  went, and `tg status` lists it under `storage.legacy_caches`. An old file with no data is
  deleted instead.

While an older tg still has the old file open, the move waits. With one account, cache
commands fail with `CACHE_UNAVAILABLE` (`details.reason`: `shared_cache_in_use`) until it
exits; with several (or none), they go on and a later run moves the file. `tg auth login`,
`login-qr`, `logout` and `tg accounts remove` fail the same way whatever the count, and change
no account: the move decides by the count when it runs, so a second account would force the
first one's cache aside, and removing one of two (or adding the first one) would hand the
account that is left rows that other accounts wrote. A file that can't be moved yet, such as a
read-only one or one on a full disk, waits the same way with `move_failed`; only a file that is
not a database is set aside even for one account. `tg status` shows a waiting move under
`storage.migration`.

To hand a set-aside file to one account yourself: stop the daemon, move that account's
`accounts/<id>/cache.db` (and its `-wal` and `-shm`, if any) away, then move
`shared-cache.db` to `accounts/<id>/cache.db`. The file holds every row from before the
upgrade, of every account that synced into it, and tg then serves all of them, access hashes
included, as that account's. Hand it over only when one account synced into it (for example,
the others were added after the older version last ran); otherwise keep it as an archive and
query it directly with `sqlite3`.

Going back to 0.3 or older after the move is not supported: it would start a new, empty
shared cache. Scripts that opened `cache.db` directly should open
`accounts/<id>/cache.db` or use `tg sql --account`. Details:
[database-schema.md](database-schema.md#from-the-shared-cache-of-03-and-older).

## Configuration File

**Path:** `<dataDir>/config.json` where `dataDir` is `TELEGRAM_SYNC_CLI_DATA_DIR` or
`~/.telegram-sync-cli`.

Supported keys:

- `activeAccount` (number): made active at every start; `tg accounts switch`, `tg auth login`
  and `tg auth login-qr` update it
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

- At the start of every command except `tg config`, `tg skill` and `tg daemon` (any output
  format, `-q` included), the CLI checks `config.json` and makes the account `activeAccount`
  names active, if it exists. While `activeAccount` is set it wins:
  `tg accounts switch --id <id>` writes `<id>` to it so the switch lasts, `tg auth login` and
  `tg auth login-qr` write the ID of the account they logged in to, and a hand edit or
  `tg config set activeAccount <id>` takes effect from the next command. Without
  `activeAccount` the active account lives only in `data.db`, and neither the switch nor a
  login creates `config.json`. A failed login leaves `activeAccount` and the active account in
  `data.db` as they were.
- If `activeAccount` has to change and `config.json` can't be written, `tg accounts switch`
  fails with `GENERAL_ERROR` (`details.path`) and changes neither file. A login has already
  succeeded by then: it fails the same way, its message starts with `Logged in as account <id>`
  and `details.account_id` names the account, and `data.db` keeps the active account it had.
  Make `config.json` writable or remove `activeAccount` from it, then run
  `tg accounts switch --id <id>` to use the new account.
- An invalid `config.json` (not a JSON object, or a supported key with a wrong value) fails
  every command except `tg config`, `tg skill` and `tg daemon` with `INVALID_ARGS` and issue
  details before it runs; `tg config set` can still fix a wrong value. A `config.json` that
  can't be read fails them with `GENERAL_ERROR` (`details.path`). `tg daemon` reads no key of
  `config.json`, so such a file doesn't stop `tg daemon start`, with `--quiet` or without; the
  next other command reports it.
- Cache-related commands resolve TTLs via `config.json` overrides.

## Validation

- `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` are required.
- Missing credentials fail fast with actionable errors.

## Security

- Treat `session_<id>.db`, `data.db`, `accounts/<id>/cache.db` and any `shared-cache*.db` as
  sensitive.
- Do not embed API credentials in compiled binaries.
