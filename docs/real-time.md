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
   forward cursor and `top_message_id` stay where they are: forward catch-up moves the cursor
   after fetching the messages below (see [sync-strategy.md](sync-strategy.md)).

A message in a chat without a state row creates one from the message's chat: its type and,
for groups, its member count decide the sync policy. A message in a chat without a
`chats_cache` row (one new to this run, such as a new DM) also caches the chat from the update,
so the chat's first page can build an InputPeer with its access hash before the next dialog
pass. A "min" user or channel is skipped: its access hash works only in the update that carried
it.

### Message Type Mapping

Media types are normalized to `message_type` values such as:
- `text`, `photo`, `video`, `document`, `sticker`, `voice`, `audio`
- `poll`, `contact`, `location`, `venue`, `game`, `invoice`, `webpage`, `dice`
- `service` for service messages

### Deletes

Delete updates mark rows as deleted instead of removing them:

- `messages_cache.is_deleted = 1`

A delete in a channel or supergroup names the chat, and the daemon marks those rows. A delete
in a private chat or basic group names only message IDs. Those IDs come from one sequence per
account, so the daemon marks the one private chat or basic group in the receiving account's
cache that has a live row with that ID, and never a channel or supergroup post with the same
ID. An ID that is not cached is skipped. If two or more of those chats still have the ID live
(for example a cache adopted from 0.3 that holds a removed account's chats), the daemon marks
neither and logs a warning. The lookup uses `idx_messages_cache_message_id`.

## Gaps / Too Long Updates

Gaps are closed by forward catch-up, not by `getDifference`. On start and after each reconnect
the daemon lists the dialogs; a chat whose newest message is above its forward cursor gets
catch-up pages until the cursor reaches it. The daemon does not perform ad-hoc full diffs on
realtime gaps.

## Implementation References

- `src/daemon/daemon-accounts.ts`
- `src/daemon/handlers.ts`
- `src/utils/message-parser.ts`
- `src/db/messages-cache.ts`
