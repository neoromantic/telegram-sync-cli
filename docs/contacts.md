# Contact Management

> **Status:** Implemented
>
> Implementation lives in `src/commands/contacts.ts` and cache access in `src/db/users-cache.ts`.

## Implemented Commands

- `tg contacts list` — List contacts with pagination and caching
- `tg contacts search` — Search contacts by name/username (cache-first, API on `--fresh`)
- `tg contacts get` — Get contact by ID or @username

### Caching Behavior

- Cache checked first unless `--fresh` is used
- Response includes `source: "cache" | "api"` and `stale: boolean`
- Stale TTL: 7 days (via `CacheConfig.staleness.peers`)

### Removed contacts

`tg contacts list --fresh` (and `tg contacts list` on an empty cache) fetches the full list
with `contacts.getContacts` and treats it as the truth. A user in the list is marked as a contact.
A cached contact the list leaves out, say one you deleted on your phone, is unmarked:
`is_contact` becomes 0, and `contact` and `mutualContact` become `false` in its `raw_json`. Its
user row stays, with its `fetched_at`, so messages from that user still show a name. Nothing is
deleted.

The full list also records a `contacts` row in `sync_state`: `last_sync_at` is when the list was
last checked, and `forward_cursor` holds Telegram's `saved_count` from it.

```bash
tg sql "SELECT entity_type, last_sync_at FROM sync_state"
```

## Current Storage

Contacts are stored in the **users cache** (`users_cache`). See `docs/database-schema.md` for the full schema.
