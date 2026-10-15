# API Design

## Philosophy: Generic API Access

Rather than manually mapping every Telegram API method to a CLI command, we provide:

1. **Generic `api` command** — Call any Telegram method directly
2. **Convenience commands** — High-level wrappers for common operations
3. **Agent-friendly output** — JSON output by default, with `pretty` and `quiet` modes

## Generic API Command

```bash
# Call any Telegram method directly
tg api account.checkUsername --username myuser
tg api messages.getHistory --peer @username --limit 10
tg api contacts.getContacts

# With JSON input for complex arguments
tg api messages.sendMessage --json '{"peer": "@user", "message": "Hello"}'

# Use a specific account
tg api account.getAuthorizations --account 2

# Raw output (no success wrapper)
tg api updates.getState --raw
```

This maps directly to mtcute's `client.call()`:
```typescript
await client.call({ _: 'account.checkUsername', username: 'myuser' })
```

### Argument Merging

The `api` command merges named CLI args with JSON (JSON wins on conflicts):
```bash
# Named args
tg api account.checkUsername --username myuser

# Nested args via dot notation
tg api messages.sendMessage --peer.username myuser --message Hello

# JSON merge
tg api messages.sendMessage --peer.username myuser --json '{"message":"Hello"}'
```

## Convenience Commands

High-level commands for common operations:

```bash
# Authentication
tg auth login --phone +15551234567
tg auth login-qr
tg auth logout
tg auth status

# Account management
tg accounts list
tg accounts switch --id 1
tg accounts remove --id 1
tg accounts info --id 1

# Contacts (with caching)
tg contacts list --limit 50 --offset 0
tg contacts search --query "John"
tg contacts get --id @username
tg contacts get --id 123456789

# Chats/Dialogs (with caching)
tg chats list --limit 50 --type private
tg chats search --query "query"   # cache-only
tg chats get --id @username        # username only

# Messages (cache-only full-text search)
tg messages search --query "hello"
tg messages search --query "hello" --chat @teamchat --sender @alice
tg messages search --query "hello" --includeDeleted

# Messaging
tg send --to @username --message "Hello"
tg send --to @username -m "Hello" --silent
tg send --to @username -m "Reply" --reply-to 123

# Status
tg status

# SQL
tg sql --query "SELECT * FROM users_cache LIMIT 10"
tg sql print-schema --table=users_cache

# Skill integration
tg skill manifest
tg skill validate
tg skill install
```

### Skill Manifest

`tg skill manifest` returns the manifest used for agent integration. `tg skill install`
writes the manifest to `<dataDir>/skill.json` (default `~/.telegram-sync-cli/skill.json`,
override with `TELEGRAM_SYNC_CLI_DATA_DIR`).

Fields:
- `name`
- `description`
- `install_command`
- `entrypoint`
- `version` (CLI version)
- `output` (always `json`)

Example output:

```json
{
  "success": true,
  "data": {
    "name": "@goodit/telegram-sync-cli",
    "description": "Agent-friendly Telegram Sync CLI",
    "install_command": "bun install -g @goodit/telegram-sync-cli",
    "entrypoint": "tg",
    "version": "<cli-version>",
    "output": "json"
  }
}
```

`tg skill validate` performs local checks only (environment variables and data
directory access). It does not make network calls.

`tg skill install` writes the manifest to the default location and returns
metadata about the write.

### Cache Behavior

All data-fetching commands support the `--fresh` flag:

```bash
# Use cached data (default)
tg contacts list

# Force fresh API fetch
tg contacts list --fresh
```

Response includes cache metadata (wrapped by `success`):
```json
{
  "success": true,
  "data": {
    "items": [],
    "source": "cache",
    "stale": false,
    "offset": 0,
    "limit": 50
  }
}
```

## Output Modes

```bash
# JSON output (default)
tg contacts list
# {"success": true, "data": {...}}

# Pretty output for humans (pretty-printed JSON payload)
tg contacts list --format pretty

# Quiet mode (no output, just exit code)
tg send --to @user --message "Hi" --format quiet
# or
tg send --to @user --message "Hi" --quiet
```

## Error Handling

All errors are returned as JSON (unless `--quiet`):

```json
{
  "success": false,
  "error": {
    "code": "PEER_ID_INVALID",
    "message": "Could not find the specified peer",
    "details": {
      "peer": "@nonexistent"
    }
  }
}
```

Exit codes:
- 0: Success
- 1: General error
- 2: Authentication required
- 3: Invalid arguments
- 4: Network error
- 5: Telegram API error / rate limited
- 6: Account not found

## Account Context

Every command runs in context of an "active" account:

```bash
# Set active account
tg accounts switch --id 1

# Or specify per-command
tg contacts list --account 2
tg contacts list --account @myuser
tg contacts list --account "Work"
tg api messages.getHistory --account 2 --peer @user
```

## Peer Resolution

Peers can be specified in multiple formats:
- Username: `@username`
- Phone: `+15551234567`
- User ID: `123456789`
- Chat ID: `-123456789`
- Channel ID: `-1001234567890`

Note: `tg chats get` currently accepts **@username only**.

## Type System

The CLI leverages mtcute's strict TypeScript types:
- Method names are validated against TL schema
- Arguments are type-checked
- Return types are known at compile time

## Implementation Notes

### Generic API Implementation

```typescript
// src/commands/api.ts (simplified)
export const apiCommand = defineCommand({
  args: {
    method: { type: 'positional' },
    json: { type: 'string' },
    account: { type: 'string' },
    raw: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const client = wrapClientCallWithRateLimits(getClientForAccount(args.account))
    const params = mergeArgs(args, args.json)
    const result = await client.call({ _: args.method, ...params })

    if (args.raw) {
      console.log(JSON.stringify(result, replacer, 2))
    } else {
      success({ method: args.method, result })
    }
  },
})
```

### Caching Pattern

Commands that fetch data follow a consistent caching pattern:

```typescript
// Example from src/commands/contacts.ts
if (!args.fresh) {
  const cached = usersCache.getByUsername(identifier)
  if (cached) {
    const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers)
    success({
      ...cachedData,
      source: 'cache',
      stale,
    })
    return
  }
}

// Fetch from API and cache
const result = await client.call({ _: 'contacts.resolveUsername', username })
usersCache.upsert(apiUserToCacheInput(result))

success({ ...freshData, source: 'api', stale: false })
```
