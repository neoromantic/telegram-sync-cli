# Caching Strategy

> **Status:** Implemented. This document describes the caching system for telegram-sync-cli, using a Stale-While-Revalidate pattern for optimal performance and user experience.

## Design Philosophy

The caching system prioritizes **responsiveness** over absolute freshness. Users get instant results from cache while explicit `--fresh` requests fetch from the API. This is critical for CLI tools where latency directly impacts usability.

### Core Principles

1. **Return cached data immediately** — Never block on network when cache exists
2. **Explicit freshness when needed** — `--fresh` flag for guaranteed current data
3. **Configurable staleness thresholds** — Different TTLs for different data types
4. **Lazy initialization** — Cache database initialized on first use for faster startup
5. **Messages are eternal** — Message records are not expired, only marked deleted

## Staleness Rules

### Data Categories

| Category | Staleness TTL | Rationale |
|----------|--------------|-----------|
| **Messages** | ETERNAL | Message history is immutable (edits tracked separately). |
| **Users/Contacts** | 1 week (default) | Profile info changes infrequently. |
| **Chats/Dialogs** | 1 week (default) | Chat metadata changes occasionally. |
| **Dialog ordering** | 1 hour (default) | Ordering changes frequently. |
| **Full info** | 1 week (default) | Extended info is relatively stable. |

### Configuration

Defaults are defined in `src/db/types.ts` and can be overridden via `config.json`:

```typescript
export function getDefaultCacheConfig(): CacheConfig {
  return {
    staleness: {
      peers: WEEK,
      dialogs: HOUR,
      fullInfo: WEEK,
    },
    backgroundRefresh: true,
    maxCacheAge: 30 * DAY,
  }
}
```

Example override:

```json
{
  "cache": {
    "staleness": {
      "peers": "3d",
      "dialogs": "2h",
      "fullInfo": "7d"
    },
    "backgroundRefresh": true,
    "maxCacheAge": "30d"
  }
}
```

## CLI Behavior

### Standard Flow (Cached)

```bash
tg contacts list
```

1. Check cache table for requested data
2. If found: return immediately with `source: "cache"`
3. If stale: include `stale: true` in response and suggest `--fresh`

### Fresh Flow (Blocking)

```bash
tg contacts list --fresh
```

1. Fetch from Telegram API (blocking)
2. Update cache with new data and `fetched_at` timestamp
3. Return fresh result with `source: "api"`

### Cache Miss Flow

```bash
tg contacts get --id @someone
```

1. Check cache table - not found
2. Fetch from Telegram API (blocking)
3. Store in cache with `fetched_at`
4. Return result with `source: "api"`

### Chat History

```bash
tg messages list --chat @username --before 1200
```

1. Read the window (`--before`, `--after`, `--limit`) from `messages_cache`
2. If it holds any message: return it with `source: "cache"`
3. If it is empty, reaches only back (`--before` without `--after`) and the chat has
   `history_complete = 1` in `chat_sync_state`: return an empty page from the cache, since the
   chat has nothing older
4. Otherwise fetch that window with `messages.getHistory`, store the messages (and their senders
   in `users_cache`) with `raw_json` and `fetched_at`, and return the page read back from the
   cache with `source: "api"`

`--fresh` always takes step 4. Fetched pages are searchable right away. The CLI doesn't move the
daemon's sync cursors and never infers deletions. Without a running daemon the cache stops at
the last sync, so the newest page can be behind Telegram; `--fresh` reads Telegram's view.

### Sent Messages

```bash
tg send --to me -m "Note to self"
```

`tg send` writes the sent message to `messages_cache` from Telegram's response,
with the same `chat_id` format as the daemon. Telegram doesn't push an update
for it to the session that sent it, and the daemon shares that session, so
without this the message would reach the cache only on a later sync. If the
cache write fails, the send still reports success.

### Cache-Only Commands

Some commands only query cache:

- `tg chats search --query "foo"`

If cache is empty, run `tg chats list --fresh` to populate it.

## Database Schema

The cache uses a separate SQLite database (`cache.db`) initialized lazily on first use via `getCacheDb()`.

**Primary cache tables:**
- `users_cache`
- `chats_cache`

**Sync tables (also in cache.db):**
- `messages_cache`
- `chat_sync_state`
- `sync_jobs`
- `daemon_status`

For full schema definitions, see `docs/database-schema.md`.

## Cache Services

The caching system uses dedicated service classes:

**UsersCache** (`src/db/users-cache.ts`):
- `getById(userId)`
- `getByUsername(username)`
- `getByPhone(phone)`
- `upsert(user)` / `upsertMany(users)`
- `search(query, limit)`
- `getStale(ttlMs)` / `prune(maxAgeMs)`

**ChatsCache** (`src/db/chats-cache.ts`):
- `getById(chatId)`
- `getByUsername(username)`
- `list(opts)`
- `search(query, limit)`
- `upsert(chat)` / `upsertMany(chats)`
- `getStale(ttlMs)` / `prune(maxAgeMs)`

## Cache Lookup Pattern (Implemented)

Example from contacts command:

```typescript
// From src/commands/contacts.ts
if (!args.fresh) {
  const cached = usersCache.getByUsername(identifier)
  if (cached) {
    const stale = isCacheStale(cached.fetched_at, cacheConfig.staleness.peers)
    success({
      ...cachedUserToContact(cached),
      source: 'cache',
      stale,
    })
    return
  }
}

// Fetch from API if cache miss or --fresh
const result = await client.call({ _: 'contacts.resolveUsername', username })
usersCache.upsert(apiUserToCacheInput(result))

success({ ...freshData, source: 'api', stale: false })
```

## Lazy Database Initialization

```typescript
// From src/db/index.ts
let cacheDb: Database | null = null

export function getCacheDb(): Database {
  if (!cacheDb) {
    cacheDb = new Database(CACHE_DB_PATH)
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)
  }
  return cacheDb
}
```

## Background Refresh

There is **no peer refresh job system** at the moment. Background work is limited to **message sync** handled by the daemon (`sync_jobs`). Peer data is refreshed only on explicit `--fresh` calls.
