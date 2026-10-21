/**
 * A cache as 0.2.0 left it (#18): the same tables, but groups and channels
 * in chats_cache under their bare IDs, a channel sender in from_id under
 * its bare ID, user_version 0 and search index version 1. messages_cache and
 * the sync tables already hold marked IDs. Made-up data only.
 */
import type { Database } from 'bun:sqlite'

import { dialogToCacheInput } from '../../commands/chats/helpers'
import { parseRawMessage } from '../../daemon/sync-worker-real-helpers'
import type { CachedChatInput } from '../../db/chats-cache'
import { createChatsCache } from '../../db/chats-cache'
import { createHistoryRanges } from '../../db/history-ranges'
import { createMessagesCache } from '../../db/messages-cache'
import { initCacheSchema } from '../../db/schema'
import { initSyncSchema } from '../../db/sync-schema'
import { createUsersCache } from '../../db/users-cache'
import { toPeerIdFromRawPeer } from '../../utils/telegram-peer-ids'
import { type FakeDialogInput, fakeDialog } from './fake-dialogs'

export const LEGACY = {
  alice: { id: 10, title: 'Alice Able', username: 'alice' },
  teamChat: { id: 1234567890, marked: -1001234567890, title: 'Team Chat' },
  bookClub: { id: 4242, marked: -4242, title: 'Book Club' },
  news: { id: 2222222222, marked: -1002222222222, title: 'Example News' },
  /** A channel that posts in Team Chat as its sender */
  senderChannel: { id: 333, marked: -1000000000333 },
} as const

/**
 * The tables of 0.2.0, which this version keeps, with user_version 0.
 * initSyncSchema migrates the empty cache; user_version is set back after.
 */
export function initLegacySchema(db: Database): void {
  initCacheSchema(db)
  initSyncSchema(db)
  setLegacyVersion(db)
}

/** Mark the cache as one 0.2.0 wrote */
export function setLegacyVersion(db: Database): void {
  db.run('PRAGMA user_version = 0')
}

/** The chats_cache row 0.2.0 wrote for a dialog: under the bare ID */
export function legacyChatRow(
  input: FakeDialogInput,
  overrides: Partial<CachedChatInput> = {},
): CachedChatInput {
  return {
    ...dialogToCacheInput(fakeDialog(input)),
    chat_id: String(input.id),
    ...overrides,
  }
}

type RawPeer =
  | { _: 'peerUser'; userId: number }
  | { _: 'peerChat'; chatId: number }
  | { _: 'peerChannel'; channelId: number }

/** A raw message as getHistory returns it */
export function rawMessage(
  peerId: RawPeer,
  id: number,
  text: string,
  fromId?: RawPeer,
  fwdFromId?: RawPeer,
) {
  return {
    _: 'message',
    id,
    peerId,
    ...(fromId ? { fromId } : {}),
    ...(fwdFromId
      ? { fwdFrom: { _: 'messageFwdHeader', fromId: fwdFromId, date: 1 } }
      : {}),
    message: text,
    date: 1_760_000_000 + id,
  }
}

function barePeerId(peer: RawPeer | undefined): number | null {
  if (!peer) return null
  if (peer._ === 'peerUser') return peer.userId
  if (peer._ === 'peerChat') return peer.chatId
  return peer.channelId
}

/**
 * The messages_cache row 0.2.0 wrote for a raw message: the chat under its
 * marked ID, the sender and the forward source under their bare IDs
 */
export function legacyMessageRow(message: ReturnType<typeof rawMessage>) {
  const chatId = toPeerIdFromRawPeer(message.peerId)!
  return {
    ...parseRawMessage(message, chatId)!,
    from_id: barePeerId(message.fromId),
    forward_from_id: barePeerId(message.fwdFrom?.fromId),
  }
}

/**
 * The standard 0.2.0 cache: Alice's DM, the supergroup Team Chat
 * (@teamchat), the basic group Book Club and the channel Example News, with
 * a message in each. In Team Chat a channel posts as the sender.
 */
export function seedLegacyCache(db: Database): void {
  const { alice, teamChat, bookClub, news, senderChannel } = LEGACY
  const now = Date.now()

  createUsersCache(db).upsert({
    user_id: String(alice.id),
    username: alice.username,
    first_name: 'Alice',
    last_name: 'Able',
    access_hash: '1111',
    fetched_at: now,
    raw_json: '{}',
  })

  createChatsCache(db).upsertMany([
    legacyChatRow({ kind: 'user', ...alice }),
    legacyChatRow({
      kind: 'supergroup',
      id: teamChat.id,
      title: teamChat.title,
      username: 'teamchat',
      membersCount: 12,
    }),
    legacyChatRow({
      kind: 'group',
      id: bookClub.id,
      title: bookClub.title,
      membersCount: 5,
    }),
    legacyChatRow({ kind: 'channel', id: news.id, title: news.title }),
  ])

  const dm = { _: 'peerUser', userId: alice.id } as const
  const team = { _: 'peerChannel', channelId: teamChat.id } as const
  const club = { _: 'peerChat', chatId: bookClub.id } as const
  const channel = { _: 'peerChannel', channelId: news.id } as const
  const fromAlice = { _: 'peerUser', userId: alice.id } as const

  createMessagesCache(db).upsertBatch([
    legacyMessageRow(rawMessage(dm, 1, 'hello from the DM', fromAlice)),
    legacyMessageRow(rawMessage(team, 1, 'hello team', fromAlice)),
    legacyMessageRow(
      rawMessage(team, 2, 'weekly digest is out', {
        _: 'peerChannel',
        channelId: senderChannel.id,
      }),
    ),
    legacyMessageRow(rawMessage(club, 1, 'hello club', fromAlice)),
    legacyMessageRow(rawMessage(channel, 1, 'hello subscribers')),
  ])

  const ranges = createHistoryRanges(db)
  for (const chatId of [alice.id, teamChat.marked, bookClub.marked]) {
    ranges.add(chatId, { low: 1, high: 1 })
  }

  setLegacyVersion(db)
}
