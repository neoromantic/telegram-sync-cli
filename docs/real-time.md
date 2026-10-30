# Real-Time Updates

> **Status: Implemented (v0.1.0)**

## Update Architecture

mtcute provides event-based update handling, which the daemon wires per account:

- `onNewMessage`
- `onEditMessage`
- `onDeleteMessage`
- `onRawUpdate`, for contact changes (see [Contacts](#contacts))

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

History pages and `tg send` write the same values ([database-schema.md](database-schema.md#table-messages_cache)).

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

### Contacts

Telegram has no "contact added" or "contact deleted" update. A contact added or removed on
another device arrives as one of these, which the daemon reads from mtcute's raw updates and
applies to the receiving account's `users_cache`:

- `updatePeerSettings` for a user, and `updateUser`: when the update carries the user's full
  record, its `contact` flag is compared with the cached `is_contact`. A changed flag rewrites
  the user's row; a user who just became a contact gets a row. An unchanged flag writes
  nothing, and a non-contact the cache doesn't have gets no row.
- The same updates without the full record, or with a "min" user, write nothing and ask for a
  hash check of the contact list a minute later. Hints within that minute share one check,
  which costs one tiny reply when nothing changed (see
  [daemon.md](daemon.md#contacts-sync)).
- `updateContactsReset`: every cached contact is unmarked and the list is checked at the next
  look (within about 30 seconds).

Ignored: `updateUserName` and `updateUserPhone` carry the user's own name and phone, not the
name you saved the contact under, and every other update. Updates mtcute recovers after a gap
while the client runs reach the handler too. Updates sent while the daemon was stopped or an
account was reconnecting are not replayed (the daemon's clients don't catch up), so each start
and reconnect asks for a hash check at the next look (see
[daemon.md](daemon.md#contacts-sync)).

## Gaps / Too Long Updates

Gaps are closed by forward catch-up, not by `getDifference`. On start and after each reconnect
or wake (see [sync-strategy.md](sync-strategy.md#reconnects-and-wakes)) the daemon lists the
dialogs; a chat whose newest message is above its forward cursor gets
catch-up pages until the cursor reaches it. The daemon does not perform ad-hoc full diffs on
realtime gaps.

## Implementation References

- `src/daemon/daemon-accounts.ts`
- `src/daemon/handlers.ts`
- `src/daemon/daemon-contacts.ts` (contact updates)
- `src/utils/message-parser.ts`
- `src/db/messages-cache.ts`
