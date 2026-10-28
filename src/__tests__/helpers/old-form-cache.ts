/**
 * A cache as tg 0.5.0 and older wrote it: raw_json by plain JSON.stringify
 * (byte arrays as objects with a key per byte, Long values as `{ low, high,
 * unsigned }`, fileReference kept), videos, voices, stickers and GIFs of
 * history pages stored as `document`, and no attachment rows. Made-up data
 * only.
 */
import type { Database } from 'bun:sqlite'
import { Long } from '@mtcute/bun'

import { registerBackgroundMigrations } from '../../db/background-migrations'
import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'
import { resolveRawMessageType } from '../../utils/message-type'
import {
  gifMessage,
  stickerMessage,
  videoMessage,
  voiceMessage,
  webpageMessage,
} from './media-messages'
import { fakeBytes, photoMessage } from './photo-message'

export const OLD_FORM_CHAT_ID = 1001

const peer = { _: 'peerUser' as const, userId: OLD_FORM_CHAT_ID }

function textMessage(id: number) {
  return {
    _: 'message' as const,
    id,
    peerId: peer,
    date: 1_760_000_000 + id,
    message: `Example note number ${id} about the lake`,
  }
}

const MAKERS = [
  (id: number) => photoMessage(peer, id),
  (id: number) => ({
    ...videoMessage(peer, id),
    groupedId: Long.fromString('-8000000000000000001'),
  }),
  (id: number) => voiceMessage(peer, id),
  (id: number) => stickerMessage(peer, id),
  (id: number) => gifMessage(peer, id),
  (id: number) => webpageMessage(peer, id),
  textMessage,
]

/** The raw messages of the fixture, as mtcute gives them */
export function oldFormMessages(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const make = MAKERS[i % MAKERS.length]!
    return make(i + 1) as { _: 'message'; id: number; media?: unknown }
  })
}

/** The message_type 0.5.0 stored for a history page message */
function oldMessageType(message: { media?: unknown }): string {
  const media = message.media as { _?: string } | undefined
  if (!media) return 'text'
  if (media._ === 'messageMediaDocument') return 'document'
  return resolveRawMessageType(message).messageType
}

/** Made-up users and chats with Long access hashes and byte fields */
export function oldFormUsers() {
  return [1, 2, 3].map((n) => ({
    _: 'user',
    id: 2000 + n,
    accessHash: Long.fromString(`-70000000000000000${n}`),
    firstName: `Example${n}`,
    photo: {
      _: 'userProfilePhoto',
      photoId: Long.fromString(`50000000000000000${n}`),
      strippedThumb: fakeBytes(40, n),
      dcId: 2,
    },
  }))
}

export function oldFormChats() {
  return [1, 2].map((n) => ({
    _: 'channel',
    id: 3000 + n,
    accessHash: Long.fromString(`80000000000000000${n}`),
    title: `Example Channel ${n}`,
    photo: {
      _: 'chatPhoto',
      photoId: Long.fromString(`60000000000000000${n}`),
      strippedThumb: fakeBytes(20, n),
      dcId: 2,
    },
  }))
}

/**
 * Write the fixture into `db` with the current schema, then register the
 * background migrations as an upgraded cache would on its first open
 */
export function seedOldFormCache(
  db: Database,
  args: { messages: number },
): void {
  initCacheSchema(db)
  initSyncSchema(db)
  // A new cache registers its migrations as done; this one predates them
  db.run('DROP TABLE cache_migrations')

  const now = 1_760_000_000_000
  const insertMessage = db.query(`
    INSERT INTO messages_cache (
      chat_id, message_id, text, message_type, has_media, date, fetched_at,
      raw_json, created_at, updated_at
    ) VALUES (
      $chat_id, $message_id, $text, $message_type, $has_media, $date, $now,
      $raw_json, $now, $now
    )
  `)
  const insertUser = db.query(`
    INSERT INTO users_cache (
      user_id, first_name, access_hash, fetched_at, raw_json, created_at, updated_at
    ) VALUES ($id, $first_name, $access_hash, $now, $raw_json, $now, $now)
  `)
  const insertChat = db.query(`
    INSERT INTO chats_cache (
      chat_id, type, title, access_hash, fetched_at, raw_json, created_at, updated_at
    ) VALUES ($id, 'channel', $title, $access_hash, $now, $raw_json, $now, $now)
  `)

  db.transaction(() => {
    for (const message of oldFormMessages(args.messages)) {
      insertMessage.run({
        $chat_id: OLD_FORM_CHAT_ID,
        $message_id: message.id,
        $text: (message as { message?: string }).message || null,
        $message_type: oldMessageType(message),
        $has_media: message.media ? 1 : 0,
        $date: 1_760_000_000 + message.id,
        $now: now,
        $raw_json: JSON.stringify(message),
      })
    }
    for (const user of oldFormUsers()) {
      insertUser.run({
        $id: String(user.id),
        $first_name: user.firstName,
        $access_hash: user.accessHash.toString(),
        $now: now,
        $raw_json: JSON.stringify(user),
      })
    }
    for (const chat of oldFormChats()) {
      insertChat.run({
        $id: String(-1_000_000_000_000 - chat.id),
        $title: chat.title,
        $access_hash: chat.accessHash.toString(),
        $now: now,
        $raw_json: JSON.stringify(chat),
      })
    }
  })()

  registerBackgroundMigrations(db)
}
