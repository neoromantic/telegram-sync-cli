# Real-Time Updates

> **Status: Implemented (v0.1.0)**

## Update Architecture

mtcute provides event-based update handling, which the daemon wires per account:

- `onNewMessage`
- `onEditMessage`
- `onDeleteMessage`

Handlers live in:
- `src/daemon/daemon-accounts.ts`
- `src/daemon/handlers.ts`

## Current Flow

1. **Event received** from mtcute
2. **Normalize** message metadata (chat type, media type, forward attribution)
3. **Persist** into `messages_cache`
4. **Update counters** in `chat_sync_state` (`synced_messages`, `last_forward_sync`). The
   forward cursor stays where it is: forward catch-up moves it after fetching the messages
   below (see [sync-strategy.md](sync-strategy.md)).

### Message Type Mapping

Media types are normalized to `message_type` values such as:
- `text`, `photo`, `video`, `document`, `sticker`, `voice`, `audio`
- `poll`, `contact`, `location`, `venue`, `game`, `invoice`, `webpage`, `dice`
- `service` for service messages

### Deletes

Delete updates mark rows as deleted instead of removing them:

- `messages_cache.is_deleted = 1`

## Gaps / Too Long Updates

Large gaps are handled by scheduling sync jobs (forward catchup / backfill). The daemon does not perform ad-hoc full diffs on realtime gaps.

## Implementation References

- `src/daemon/daemon-accounts.ts`
- `src/daemon/handlers.ts`
- `src/utils/message-parser.ts`
- `src/db/messages-cache.ts`
