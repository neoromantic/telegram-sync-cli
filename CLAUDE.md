# Telegram Sync CLI - Development Guidelines

## Quick Reference

```bash
# Run CLI (development)
bun run src/index.ts <command>

# Build binary (current platform)
bun run build

# Build for all platforms
bun run build:all

# Test build output
bun run test:build

# Test global installation
bun run test:install

# Run unit tests
bun run test

# Run integration tests (real API, optional)
bun run test:integration

# Run E2E tests
bun run test:e2e

# Run all tests (unit + E2E)
bun run test:all

# Run tests with coverage
bun run test:coverage

# Type check (fast, using tsgo)
bun run typecheck

# Type check (fallback to tsc if tsgo has issues)
bun run typecheck:tsc

# Lint (check only)
bun run lint

# Lint and auto-fix
bun run lint:fix

# Format
bun run format
```

---

## Git Hooks (Automated)

Pre-commit hooks run automatically via **lefthook**:
1. `bun run lint:fix` — Auto-fixes linting issues
2. `bun run typecheck` — Type checks with tsgo

If hooks fail, fix the errors and commit again. To skip hooks (emergency only):
```bash
git commit --no-verify -m "message"
```

---

## CI Pipeline

GitHub Actions runs on every push to `main` and on all PRs:

| Job | What it does | Timeout |
|-----|--------------|---------|
| **lint** | `bun run lint` (Biome) | 5 min |
| **typecheck** | `bun run typecheck:tsc` | 5 min |
| **test** | `bun test` | 10 min |
| **build-test** | Compile binary and verify it runs | 5 min |

All jobs run in parallel with Bun dependency caching. See `.github/workflows/ci.yml`.

---

## Build & Distribution

### Installing Globally

```bash
# From npm/bun registry (once published)
bun install -g @goodit/telegram-sync-cli

# From local source
bun link
```

The npm package does not include `dist/tg`. The `postinstall` script
automatically compiles a native binary to `dist/tg` locally (Bun required).

### Build Scripts

| Script | Purpose |
|--------|---------|
| `bun run build` | Compile binary for current platform → `dist/tg` |
| `bun run build:minify` | Minified build with sourcemaps |
| `bun run build:all` | Cross-compile for all platforms (darwin, linux, windows) |
| `bun run test:build` | Verify build output works |
| `bun run test:install` | Test `bun link` installation |

### Binary Size

The compiled binary is ~60MB (includes embedded Bun runtime + SQLite). It is
built locally and not shipped in the npm tarball.

### Supported Platforms

- `bun-darwin-arm64` — macOS Apple Silicon
- `bun-darwin-x64` — macOS Intel
- `bun-linux-x64` — Linux x86_64
- `bun-linux-arm64` — Linux ARM64
- `bun-windows-x64` — Windows x86_64

---

## ⚠️ CRITICAL Rules

### Documentation
- **Update docs/plans/*.md** when implementing features
- **Update ROADMAP.md** when completing phases
- **Update CLAUDE.md Tech Stack table** when adding/changing dev tools (linters, typecheckers, CI, git hooks, etc.)
- **Update CLAUDE.md sections** when adding infrastructure (CI pipelines, git hooks, deployment configs)
- **Never implement without reading the relevant plan first**

### Architecture
- **CLI and Daemon are the same binary** — different entry modes
- **Daemon is READ-ONLY** — never sends messages, edits, or performs mutations
- **CLI handles all mutations** — send, edit, delete, create groups
- **Separate database per account** — don't mix account data
- **Don't modify mtcute internals** — create parallel tables

### Data
- **Messages are eternal** — never considered stale
- **Peers expire in 1 week** — contacts, groups, channels
- **Always store raw_json** — for future-proofing
- **Use fetched_at timestamps** — on all cached entities

### Commits
- **Commit when feature is complete** — after tests pass, typecheck runs, and docs are updated
- **Don't batch unrelated changes** — each commit should be atomic and focused
- **Keep working directory clean** — don't leave uncommitted changes hanging

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Runtime | Bun | Native SQLite, fast startup, TS support |
| Language | TypeScript | Strict mode, full type safety |
| Telegram | mtcute (`@mtcute/bun`) | TypeScript-first, Bun support, `client.call()` |
| CLI | Citty | TypeScript-first, ES modules, lightweight |
| Database | bun:sqlite | Native, zero deps, WAL mode |
| Linting | Biome | Fast, all-in-one |
| Type Checker | tsgo | 10x faster than tsc, Go-based |
| Git Hooks | lefthook | Simple, parallel execution |
| CI | GitHub Actions | Lint, typecheck, test on PRs and main |

---

## Bun-Native APIs (Always Prefer)

```typescript
// ✅ Correct
import { Database } from 'bun:sqlite'
const file = Bun.file('path.json')
await Bun.write('file.txt', content)
const result = await Bun.$`git status`

// ❌ Wrong
import sqlite3 from 'better-sqlite3'
import { readFile } from 'node:fs/promises'
import { exec } from 'child_process'
```

- `bun:sqlite` — NOT better-sqlite3
- `Bun.file()` — NOT fs.readFile
- `Bun.write()` — NOT fs.writeFile
- `Bun.$` — NOT execa or child_process
- Bun auto-loads `.env` — NO dotenv needed

---

## Architecture Overview

```
CLI Mode (tg <cmd>)           Daemon Mode (tg daemon start)
        │                              │
        ▼                              ▼
┌───────────────┐              ┌───────────────┐
│ Query cache   │              │ Real-time     │
│ On-demand API │              │ updates       │
│ Mutations     │              │ Backfill      │
└───────┬───────┘              └───────┬───────┘
        │                              │
        ▼                              ▼
    SQLite (WAL mode) ◄────────────────┘
    Per-account DBs
```

### Daemon Responsibilities (READ-ONLY)
- Maintain MTProto connections (max 5 accounts)
- Receive real-time updates
- Background history sync
- Rate limit handling

### CLI Responsibilities (MUTATIONS)
- Send messages
- Edit messages
- Create/edit groups
- Query cached data
- On-demand API fetches

---

## Sync Strategy

### Two Cursors Per Chat
1. **Forward cursor** — Real-time updates, catches up on restart
2. **Backward cursor** — History backfill, older messages

### Priorities
| P | Scope | Sync |
|---|-------|------|
| 0 | Real-time | Immediate when daemon runs |
| 1 | DMs + groups <20 | Full history |
| 2 | Groups 20-100 | Last 10, then gradual |
| 3 | Groups >100 / channels | On request only |

---

## Code Patterns

### Command Structure
```typescript
import { defineCommand } from 'citty'
import { success, error } from '../utils/output'

export const myCommand = defineCommand({
  meta: {
    name: 'my-command',
    description: 'What it does'
  },
  args: {
    param: {
      type: 'string',
      description: 'Parameter description',
      required: true
    },
    fresh: {
      type: 'boolean',
      description: 'Bypass cache',
      default: false
    }
  },
  async run({ args }) {
    try {
      const result = await doSomething(args.param, { fresh: args.fresh })
      success({ data: result })
    } catch (err) {
      error('OPERATION_FAILED', err.message)
    }
  }
})
```

### Database Pattern
```typescript
import { Database } from 'bun:sqlite'

class ContactRow {
  user_id!: number
  first_name!: string
  username!: string | null
  fetched_at!: number
  raw_json!: string
}

const db = new Database('data.db')
db.run('PRAGMA journal_mode = WAL')

const stmt = db.query(`
  SELECT * FROM contacts_cache
  WHERE username = $username
`).as(ContactRow)

const contact = stmt.get({ $username: 'someone' })
```

### Cache Check Pattern
```typescript
async function getUser(username: string, opts: { fresh?: boolean } = {}) {
  // 1. Check cache first (unless --fresh)
  if (!opts.fresh) {
    const cached = db.query('SELECT * FROM users_cache WHERE username = $u')
      .get({ $u: username })

    if (cached) {
      // Trigger background refresh if stale
      if (isStale(cached.fetched_at, PEER_TTL)) {
        queueBackgroundRefresh('user', username)
      }
      return JSON.parse(cached.raw_json)
    }
  }

  // 2. Fetch from API
  const user = await client.call({ _: 'users.getUsers', id: [username] })

  // 3. Cache response
  db.run(`
    INSERT OR REPLACE INTO users_cache (user_id, username, raw_json, fetched_at)
    VALUES ($id, $username, $json, $now)
  `, { $id: user.id, $username: username, $json: JSON.stringify(user), $now: Date.now() })

  return user
}
```

### Telegram Client Pattern
```typescript
import { TelegramClient } from '@mtcute/bun'

const client = new TelegramClient({
  apiId: API_ID,
  apiHash: API_HASH,
  storage: sessionPath,  // mtcute handles persistence
  logLevel: 2
})

// High-level methods
await client.start({ phone, code, password })
await client.signInQr({ onUrlUpdated, password })
const me = await client.getMe()

// Raw API calls (any Telegram method)
const result = await client.call({
  _: 'contacts.getContacts',
  hash: 0n  // Use BigInt for Long types
} as any)

// Iterate dialogs
for await (const dialog of client.iterDialogs({ limit: 100 })) {
  console.log(dialog.peer)
}
```

---

## File Structure

```
~/.telegram-sync-cli/
├── config.json           # Global config
├── daemon.pid            # PID when daemon running
└── accounts/
    └── 1/
        ├── session.db    # mtcute session (DON'T TOUCH)
        ├── data.db       # Our cache tables
        └── meta.json     # Account metadata

src/
├── index.ts              # CLI entry point
├── version.ts            # CLI version (read from package.json)
├── __tests__/            # Unit tests (bun:test)
│   ├── auth.test.ts      # Authentication tests
│   ├── db.test.ts        # Database tests
│   ├── output.test.ts    # Output utilities tests
│   ├── telegram.test.ts  # Telegram service tests
│   └── types.test.ts     # Type definitions tests
├── commands/
│   ├── auth.ts           # login, logout, status
│   ├── accounts.ts       # list, add, switch, remove
│   ├── contacts.ts       # list, get, search
│   ├── daemon.ts         # start, stop, status
│   ├── chats.ts          # chats barrel
│   ├── chats/            # chats helpers
│   ├── send.ts           # send barrel
│   ├── send/             # peer resolution helpers
│   ├── api.ts            # generic API command
│   ├── sql.ts            # sql barrel
│   ├── sql/              # schema + query helpers
│   ├── status.ts         # status barrel
│   ├── status/           # formatting helpers
│   ├── user.ts           # user barrel
│   └── user/             # me/lookup helpers
├── services/
│   └── telegram.ts       # Client manager
├── db/
│   ├── index.ts          # Database setup and account db
│   ├── schema.ts         # Base cache schema definitions
│   ├── types.ts          # Database type definitions
│   ├── cache.ts          # Cache operations
│   ├── cache-index.ts    # Cache index utilities
│   ├── users-cache.ts    # Users cache service
│   ├── chats-cache.ts    # Chats cache service
│   ├── messages-cache.ts # Messages cache service
│   ├── rate-limits.ts    # Rate limit tracking
│   ├── sync-schema.ts    # Sync system tables (messages, jobs, state)
│   ├── sync-jobs.ts      # Background sync job queue
│   ├── chat-sync-state.ts # Per-chat sync state with dual cursors
│   └── daemon-status.ts  # Daemon status key-value store
├── daemon/
│   ├── index.ts          # Daemon entry point
│   ├── daemon.ts         # Main daemon implementation (thin)
│   ├── daemon-context.ts # Context setup
│   ├── daemon-logger.ts  # Logger setup
│   ├── daemon-loop.ts    # Main loop orchestration
│   ├── daemon-accounts.ts # Account wiring
│   ├── daemon-scheduler.ts # Scheduler wiring
│   ├── daemon-utils.ts   # Shared helpers
│   ├── types.ts          # Daemon types and interfaces
│   ├── handlers.ts       # Telegram update handlers
│   ├── scheduler.ts      # Sync job scheduler
│   ├── sync-worker.ts    # Sync worker exports (barrel)
│   ├── sync-worker-core.ts # Core job processing logic
│   ├── sync-worker-real.ts # mtcute integration + exports
│   ├── sync-worker-real-helpers.ts # API fetch helpers
│   ├── sync-worker-real-context.ts # Real worker context
│   ├── sync-worker-real-types.ts # Real worker types
│   ├── sync-worker-real-jobs.ts # Real job handlers
│   ├── sync-worker-runner.ts # Worker loop runner
│   ├── sync-worker-utils.ts # Shared worker helpers
│   ├── job-executor.ts   # Job executor (wraps sync worker)
│   └── pid-file.ts       # PID file management
├── types/
│   └── index.ts          # TypeScript types
└── utils/
    ├── args.ts           # CLI argument parsing
    ├── cache-pagination.ts # Cache pagination helpers
    ├── csv.ts            # CSV formatting
    ├── formatting.ts     # Shared pretty format helpers
    ├── identifiers.ts    # Identifier parsing helpers
    ├── message-parser.ts # Message parsing and forward attribution
    ├── output.ts         # JSON/pretty output
    ├── telegram-mappers.ts # mtcute → cache mappers
    ├── telegram-resolve.ts # Peer resolution helpers
    └── time.ts           # Time utilities
```

---

## Testing Strategy

### Unit Tests (Offline)
- Location: `src/__tests__/*.test.ts`
- Mock mtcute client
- Test cache logic, command parsing, output formatting
- Use `createTestDatabase()` for isolated in-memory databases

### E2E Tests (Offline)
- Location: `src/__e2e__/*.e2e.test.ts`
- Execute CLI binary via `Bun.spawn`
- Test actual command behavior, argument parsing, exit codes
- Use `TELEGRAM_SYNC_CLI_DATA_DIR` env var for test isolation
- Each test gets a unique temp directory with fresh database

**Key E2E patterns:**
```typescript
// Create isolated environment
const env = createTestEnvironment('my-test')
env.initDatabase()
env.seedAccounts([{ phone: '+1234567890', is_active: true }])

// Run CLI with isolated data dir
const result = await runCliSuccess(['accounts', 'list'], env.getCliOptions())

// Check JSON output
expect(result.json?.success).toBe(true)

// Clean up
env.cleanup()
```

### Integration Tests (Online)
- Location: `src/__integration__/*.integration.test.ts`
- Run: `bun run test:integration`
- Required env: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
  `TELEGRAM_TEST_ACCOUNT`, `TELEGRAM_TEST_SESSION_PATH` (or
  `TELEGRAM_TEST_SESSION`)
- Optional env: `TELEGRAM_TEST_RECIPIENT`
- Record/replay fixtures: set `TELEGRAM_API_RECORD=1` or
  `TELEGRAM_API_REPLAY=1` (override path with
  `TELEGRAM_API_FIXTURES_DIR`)

---

## CLI UX Guidelines

### Help Output
```
tg <command> [options]

Commands:
  auth        Authentication (login, logout, status)
  accounts    Account management
  contacts    Contact operations
  send        Send messages
  chats       List dialogs
  daemon      Background sync
  status      Show sync status
  api         Raw API calls
  skill       AI integration

Global Options:
  --account   Use specific account (ID, @username, or label)
  --format    Output format (json, table)
  --fresh     Bypass cache, fetch from API
  --verbose   Detailed output
  --quiet     Minimal output
  --help      Show help
```

### Error Output
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "details": { "wait": 30 },
    "suggestion": "Wait 30 seconds or use --account to switch"
  }
}
```

---

## Common Mistakes to Avoid

1. **Don't use Node.js APIs** when Bun equivalents exist
2. **Don't modify mtcute's session.db** — it handles its own storage
3. **Don't sync large groups by default** — only on explicit request
4. **Don't block on stale data** — return cached, refresh in background
5. **Don't forget BigInt** for Telegram Long types (hash, accessHash)
6. **Don't hardcode staleness** — use configurable TTLs

---

## Key Decisions Reference

| Decision | Choice |
|----------|--------|
| Daemon startup | Manual, foreground (`tg daemon start`) |
| Max accounts | 5 |
| Message staleness | Eternal |
| Peer staleness | 1 week |
| On-demand fetch | Stale-while-revalidate + `--fresh` |
| Account ID | Numeric, @username, or custom label |
| Config format | JSON |
| Database | Separate per account |

---

## Documentation Links

### Implementation Docs (Completed)
- [Architecture](docs/architecture.md)
- [Daemon](docs/daemon.md)
- [Sync Strategy](docs/sync-strategy.md)
- [CLI Commands](docs/cli-commands.md)
- [Rate Limiting](docs/rate-limiting.md)
- [Configuration](docs/configuration.md)
- [Build & Distribution](docs/build-distribution.md)
- [Authentication](docs/auth.md)
- [Caching](docs/caching.md)
- [Database Schema](docs/database-schema.md)
- [Testing](docs/testing.md)

### Planning Docs
- [AI Integration](docs/plans/ai-integration.md)
- [Multi-Account](docs/plans/multi-account.md)
- [Core Infrastructure](docs/plans/core-infrastructure.md)
- [Groups](docs/plans/groups.md)
- [Channel Tags](docs/plans/channel-tags.md)

---

*Last updated: 2026-02-03 02:48:12 (post-compaction)*
