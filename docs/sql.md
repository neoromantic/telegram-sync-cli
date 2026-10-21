# SQL Command

The `tg sql` command provides direct SQL access to the local cache database for power users, debugging, and AI agent integration.

## Key Features

- **READ-ONLY**: Prevents accidental data corruption
- **Annotated schema**: Built-in documentation for all tables and columns
- **AI-friendly output**: JSON output for machine consumption, CSV for export

---

## Database Target

The command operates on the **cache database**:

- Default: `~/.telegram-sync-cli/cache.db`
- Override: `TELEGRAM_SYNC_CLI_DATA_DIR=/path` → `/path/cache.db`

| Table | Description | TTL |
|-------|-------------|-----|
| `users_cache` | Cached Telegram user information | 1 week |
| `chats_cache` | Cached chat/group/channel information | 1 week |
| `messages_cache` | Synced messages from enabled chats | Eternal |
| `sync_state` | Global sync progress tracking | N/A |
| `chat_sync_state` | Per-chat sync progress | N/A |
| `sync_jobs` | Background sync job queue | N/A |
| `rate_limits` | API rate limiting data | N/A |
| `api_activity` | API call audit log | N/A (no automatic cleanup yet) |
| `daemon_status` | Daemon runtime state | N/A |

**Note:** Account information is stored separately in `data.db`. Use `tg accounts list` for account queries.

---

## Usage

### Execute SQL Query

```bash
# JSON output (default)
tg sql --query="SELECT * FROM users_cache LIMIT 10"
tg sql "SELECT user_id, username FROM users_cache WHERE is_contact = 1"

# CSV output
tg sql --query="SELECT user_id, username FROM users_cache" --output=csv

# Custom row limit
tg sql --query="SELECT * FROM messages_cache" --limit=5000

# Unlimited rows
tg sql --query="SELECT * FROM messages_cache" --limit=0
```

### View Database Schema

```bash
# Full schema (all tables, JSON)
tg sql print-schema

# Single table schema
tg sql print-schema --table=users_cache

# Text format (human readable)
tg sql print-schema --table=users_cache --output=text

# SQL format (annotated DDL with comments)
tg sql print-schema --table=users_cache --output=sql
```

---

## Options

### `tg sql`

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--query` | `-q` | SQL query to execute | - |
| `--output` | `-o` | Output format: `json`, `csv` | `json` |
| `--limit` | `-l` | Max rows to return (0 = unlimited) | `1000` |

### `tg sql print-schema`

| Flag | Alias | Description | Default |
|------|-------|-------------|---------|
| `--table` | `-t` | Show schema for specific table | All tables |
| `--output` | `-o` | Output format: `json`, `text`, `sql` | `json` |

---

## Output Formats

### JSON (Default)

```bash
tg sql --query="SELECT user_id, username FROM users_cache LIMIT 2"
```

```json
{
  "success": true,
  "data": {
    "columns": ["user_id", "username"],
    "rows": [
      {"user_id": "123456", "username": "alice"},
      {"user_id": "789012", "username": "bob"}
    ],
    "rowCount": 2
  }
}
```

### CSV

```bash
tg sql --query="SELECT user_id, username FROM users_cache" --output=csv
```

```csv
user_id,username
123456,alice
789012,bob
```

CSV formatting follows RFC 4180:
- Fields with commas, quotes, or newlines are quoted
- Quotes are escaped by doubling (`"` → `""`)
- NULL values are empty fields
- Header row always included

---

## Schema Output

### JSON Format

```bash
tg sql print-schema --table=users_cache
```

Returns table metadata with column descriptions, types, and annotations.

### Text Format

```bash
tg sql print-schema --table=users_cache --output=text
```

```
Table: users_cache
Description: Cached Telegram user profiles...
TTL: 1 week
Primary Key: user_id

Columns:
  user_id  [PK, NN]
    Telegram user ID (unique identifier)
    Type: bigint_string
  username
    Telegram @username without the @ symbol
    Type: username
  ...

Indexes:
  idx_users_cache_username: Fast lookup by @username
```

### SQL Format

```bash
tg sql print-schema --table=users_cache --output=sql
```

Outputs annotated SQL DDL with inline comments explaining each column:

```sql
-- Cached Telegram user profiles. Includes contacts, chat participants, and any user encountered.
-- TTL: 1 week
CREATE TABLE users_cache (
  user_id              TEXT         PRIMARY KEY,                                -- Telegram user ID (unique identifier) [bigint_string]
  username             TEXT        ,                                            -- Telegram @username without the @ symbol [username]
  first_name           TEXT        ,                                            -- User's first name as set in their profile
  phone                TEXT        ,                                            -- Phone number (only visible for contacts) [phone]
  is_contact           INTEGER      DEFAULT 0,                                  -- Whether user is in your contacts list [boolean_int]
  fetched_at           INTEGER      NOT NULL,                                   -- Unix timestamp (ms) when data was fetched [timestamp]
  raw_json             TEXT         NOT NULL,                                   -- Complete Telegram User object as JSON [json]
  ...
);

-- Fast lookup by @username
CREATE INDEX idx_users_cache_username ON users_cache(username) WHERE username IS NOT NULL;
```

SQL comments include:
- **Table description** as header comment
- **TTL** if applicable (for cache tables)
- **Column descriptions** explaining purpose
- **Semantic type hints** in brackets: `[bigint_string]`, `[timestamp]`, `[json]`, `[boolean_int]`, `[enum]`
- **Enum values** for enum columns (e.g., `Values: text | photo | video | ...`)
- **Index descriptions** explaining each index's purpose

---

## Security

### Read-Only Enforcement

Write operations are blocked:

```bash
tg sql --query="DELETE FROM users_cache"
# Error: SQL_WRITE_NOT_ALLOWED
```

### Blocked Operations

- `INSERT`, `UPDATE`, `DELETE`, `REPLACE`
- `DROP`, `ALTER`, `CREATE`, `TRUNCATE`
- `ATTACH`, `DETACH`
- `VACUUM`, `REINDEX`

---

## Example Queries

### Count messages per chat
```bash
tg sql --query="SELECT chat_id, COUNT(*) as count FROM messages_cache GROUP BY chat_id ORDER BY count DESC LIMIT 10"
```

### Find users by username pattern
```bash
tg sql --query="SELECT user_id, username, first_name FROM users_cache WHERE username LIKE '%john%'"
```

### Check cache freshness
```bash
tg sql --query="SELECT entity_type, datetime(last_sync_at/1000, 'unixepoch') as last_sync FROM sync_state"
```

### View rate limit status
```bash
tg sql --query="SELECT method, datetime(flood_wait_until/1000, 'unixepoch') as wait_until FROM rate_limits WHERE flood_wait_until IS NOT NULL"
```

### Export contacts to CSV
```bash
tg sql --query="SELECT first_name, last_name, username, phone FROM users_cache WHERE is_contact = 1" --output=csv > contacts.csv
```

---

## Error Codes

| Code | Description |
|------|-------------|
| `SQL_SYNTAX_ERROR` | Invalid SQL syntax |
| `SQL_TABLE_NOT_FOUND` | Table doesn't exist |
| `SQL_WRITE_NOT_ALLOWED` | Write operation attempted |
| `SQL_OPERATION_BLOCKED` | Blocked operation (ATTACH, etc.) |

---

## Implementation

Source files:
- `src/commands/sql/query.ts` - SQL query command
- `src/commands/sql/print-schema.ts` - Schema display command
- `src/commands/sql/schema-text.ts` - Text and SQL format output
- `src/db/schema-annotations.ts` - Schema metadata registry
- `src/utils/csv.ts` - CSV formatting utilities

---

*Last updated: 2026-02-03*
