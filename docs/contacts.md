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

### Daemon refresh

A running daemon keeps who is a contact current by itself: on each start and reconnect (so also
the first start after an upgrade, with no recorded list), and then every peer TTL
(`cache.staleness.peers`, one week by default), it checks the list with Telegram's hash in the
background. An unchanged list costs one tiny reply and writes no contact rows (only the check
time in `sync_state` moves); a changed one is applied as above. Details:
[daemon.md](daemon.md#contacts-sync).

The hash covers only who is in the list, not the contacts' names, usernames or phones. Those
refresh when the list changed and Telegram sent it in full, or with `--fresh`. So `stale` in
`tg contacts list` still follows the rows' `fetched_at`, and can be `true` while a daemon runs
and has just confirmed the list.

Contacts added or removed on another device reach the cache when Telegram sends the update
for them ([real-time.md](real-time.md#contacts)). A contact you add or delete with
`tg api contacts.*` reaches the cache at the daemon's next check, within the peer TTL (the hash
comes from the cache, so it differs and Telegram sends the full list), or at once with
`tg contacts list --fresh`.

## Current Storage

Contacts are stored in the **users cache** (`users_cache`). See `docs/database-schema.md` for the full schema.
