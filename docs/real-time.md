# Real-Time Updates

> **Status: Implemented (v0.1.0)**

## Update Architecture

mtcute provides event-based update handling, which the daemon wires per account:

- `onNewMessage`
- `onEditMessage`
- `onDeleteMessage`
- `onRawUpdate`, for contact changes (see [Contacts](#contacts)) and reads (see
  [Unread counts](#unread-counts))

Handlers live in:

- `src/daemon/daemon-accounts.ts`
- `src/daemon/handlers.ts`

## Current Flow

1. **Event received** from mtcute
2. **Normalize** message metadata (chat type, media type, forward attribution)
3. **Persist** into `messages_cache`, unless the chat is a group the account
   [doesn't take part in](sync-strategy.md#group-participation). An own message counts before it
   is written, so it turns such a group back on and is cached itself; a service message
   doesn't count.
4. **Update counters** in `chat_sync_state` (`synced_messages`, `last_forward_sync`) by the
   messages actually added. The
   forward cursor and `top_message_id` stay where they are: forward catch-up moves the cursor
   after fetching the messages below (see [sync-strategy.md](sync-strategy.md)).

A message in a chat without a state row creates one from the message's chat: its type and,
for groups, its member count decide the sync policy, and a bot or a deleted account gets the
newest page only. A message in a chat without a
`chats_cache` row (one new to this run, such as a new DM) also caches the chat from the update,
so the chat's first page can build an InputPeer with its access hash before the next dialog
pass. A "min" user or channel is skipped: its access hash works only in the update that carried
it.

### Channels

The handlers cache every message mtcute delivers, in a chat with sync off too (a group only
while the account takes part in it), and never move its cursor. What mtcute delivers for a channel depends on Telegram and on mtcute's update
state:

- Telegram "will usually send passive updates" for the channels and supergroups you are in,
  but "may stop sending updates (or send fewer updates) for some" of them, and clients are
  expected to poll `updates.getChannelDifference` only for the few channels a user has open
  ([Telegram's updates docs](https://core.telegram.org/api/updates)). The daemon has no
  channel open.
- When Telegram signals a channel gap (`updateChannelTooLong`, or a gap in `pts`), mtcute
  fetches the channel's difference only from a `pts` it already has: one from an earlier update
  of that channel, or the one the signal carries. For a channel it never got an update from,
  it has none and skips the gap; with the signal's own `pts` the difference starts at the
  channel's current state. Either way the posts in between are not delivered.

So a channel with sync off may get none of its posts live. Each dialog pass (on start, after a
reconnect and after a wake) caches the newest message of every chat with sync off, from the
dialog list it reads anyway (in a group, only while the account takes part in it). Older posts of such a channel come only with `tg chats sync`.

### Unread counts

`chats_cache` keeps each chat's unread state: `unread_count` and `read_inbox_max_id`, the read
boundary (every incoming message up to it is read). The daemon keeps both current between
dialog passes:

- Every dialog pass (on start, after a reconnect and after a wake) and `tg chats list --fresh`
  set both from the dialog list.
- A new incoming message raises `unread_count` by one when it is above the read boundary and
  above the chat's newest known message (`last_message_id`), so a message delivered twice counts
  once. Every live message raises `last_message_id` and `last_message_at`, so `tg chats list`
  keeps the order of recent activity between passes. An outgoing message counts nothing.
- A read here or on another device arrives as `updateReadHistoryInbox` (private chats, basic
  groups, Saved Messages) or `updateReadChannelInbox` (supergroups, channels), with
  `stillUnreadCount`: both columns take its values. A read within one forum topic
  (`topMsgId`) is skipped. `tg messages read` writes the state Telegram reports right away.
- A chat that no dialog pass listed and a live message brings in starts with its boundary just
  below that message, so the message counts as unread; the next pass sets the real state.

So with the daemon running, the counts follow Telegram. Deletes don't lower them, and an update
that never arrives (a channel Telegram stops sending, a gap) leaves them as they were until the
next pass. Without a running daemon they are as old as the last dialog list; `tg chats list
--unread --fresh` and `tg messages unread --fresh` read them from Telegram.

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

## How fresh wait and watch are

`tg messages wait` and `tg messages watch` read what the daemon stores in the account's cache
and check it every 200 ms, so a message comes back within about a second of being stored
([cli-commands.md](cli-commands.md#waiting-for-new-messages)). The daemon stores a message as
soon as mtcute delivers it: every new message of a private chat or group, in a chat with sync
off too (a group only while the account takes part in it, see
[group participation](sync-strategy.md#group-participation): in another group they see nothing
until your next message there), and the channel posts Telegram pushes (see [Channels](#channels): some channels get
none live, and their newest post arrives with the next dialog pass). Messages sent while the
daemon was stopped or reconnecting arrive with catch-up after the start or reconnect, in the
chats that get it ([sync-strategy.md](sync-strategy.md)). An edit or a delete changes a stored message and is not a new one.

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
- `src/db/messages-cache.ts`
