import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'

import { resolvePeer } from '../commands/send/peer-resolver'
import { type ChatsCache, createChatsCache } from '../db/chats-cache'
import { createTestCacheDatabase } from '../db/schema'
import type { ChatType } from '../db/types'
import { createUsersCache, type UsersCache } from '../db/users-cache'
import { toLong } from '../utils/long'

function throwingClient() {
  const call = mock(async (_request: unknown) => {
    throw new Error('unexpected API call')
  })
  return { call, client: { call } as unknown as Pick<TelegramClient, 'call'> }
}

describe('resolvePeer', () => {
  it.each(['me', 'self', ' Me '])(
    'resolves %p to Saved Messages without an API call',
    async (identifier) => {
      const call = mock(async () => {
        throw new Error('unexpected API call')
      })
      const client = { call } as unknown as Pick<TelegramClient, 'call'>

      const peer = await resolvePeer(
        client,
        identifier,
        {} as UsersCache,
        {} as ChatsCache,
      )

      expect(peer).toEqual({
        inputPeer: { _: 'inputPeerSelf' },
        name: 'Saved Messages',
      })
      expect(call).not.toHaveBeenCalled()
    },
  )
})

describe('resolvePeer with numeric IDs', () => {
  let db: Database
  let usersCache: UsersCache
  let chatsCache: ChatsCache

  beforeEach(() => {
    db = createTestCacheDatabase().db
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
  })

  function cacheChat(
    chatId: string,
    type: ChatType,
    title: string,
    accessHash: string | null = null,
  ) {
    chatsCache.upsert({
      chat_id: chatId,
      type,
      title,
      username: null,
      member_count: null,
      access_hash: accessHash,
      is_creator: 0,
      is_admin: 0,
      last_message_id: null,
      last_message_at: null,
      fetched_at: Date.now(),
      raw_json: '{}',
    })
  }

  function resolve(identifier: string, client: Pick<TelegramClient, 'call'>) {
    return resolvePeer(client, identifier, usersCache, chatsCache)
  }

  describe('marked IDs, as tg messages search and tg sql print them', () => {
    it('resolves a cached channel from its raw ID', async () => {
      cacheChat('1234567890', 'supergroup', 'Team Chat', '2222')
      const { call, client } = throwingClient()

      const peer = await resolve('-1001234567890', client)

      expect(peer).toEqual({
        inputPeer: {
          _: 'inputPeerChannel',
          channelId: 1234567890,
          accessHash: toLong('2222'),
        },
        name: 'Team Chat',
      })
      expect(call).not.toHaveBeenCalled()
    })

    it('resolves a cached basic group', async () => {
      cacheChat('4242', 'group', 'Book Club')
      const { call, client } = throwingClient()

      const peer = await resolve('-4242', client)

      expect(peer).toEqual({
        inputPeer: { _: 'inputPeerChat', chatId: 4242 },
        name: 'Book Club',
      })
      expect(call).not.toHaveBeenCalled()
    })

    it('rejects a cached row whose own marked ID is different', async () => {
      // A private chat with raw ID 4242 is user 4242, not group -4242
      cacheChat('4242', 'private', 'Alice Able', '1111')
      const { call, client } = throwingClient()

      const peer = await resolve('-4242', client)

      expect(peer.inputPeer).toEqual({ _: 'inputPeerChat', chatId: 4242 })
      expect(call).not.toHaveBeenCalled()
    })

    it('builds an uncached channel without an API call', async () => {
      const { call, client } = throwingClient()

      const peer = await resolve('-1009999999999', client)

      expect(peer.inputPeer).toEqual({
        _: 'inputPeerChannel',
        channelId: 9999999999,
        accessHash: toLong(0),
      })
      expect(call).not.toHaveBeenCalled()
    })

    it('builds an uncached basic group without an API call', async () => {
      const { call, client } = throwingClient()

      const peer = await resolve('-4343', client)

      expect(peer.inputPeer).toEqual({ _: 'inputPeerChat', chatId: 4343 })
      expect(call).not.toHaveBeenCalled()
    })
  })

  describe('bare numbers', () => {
    it('resolves a cached 10-digit chat ID without a phone lookup', async () => {
      cacheChat('1234567890', 'supergroup', 'Team Chat', '2222')
      const { call, client } = throwingClient()

      const peer = await resolve('1234567890', client)

      expect(peer.inputPeer).toEqual({
        _: 'inputPeerChannel',
        channelId: 1234567890,
        accessHash: toLong('2222'),
      })
      expect(call).not.toHaveBeenCalled()
    })

    it('resolves a cached 10-digit user ID without a phone lookup', async () => {
      usersCache.upsert({
        user_id: '1234567890',
        first_name: 'Alice',
        last_name: 'Able',
        access_hash: '3333',
        fetched_at: Date.now(),
        raw_json: '{}',
      })
      const { call, client } = throwingClient()

      const peer = await resolve('1234567890', client)

      expect(peer).toEqual({
        inputPeer: {
          _: 'inputPeerUser',
          userId: 1234567890,
          accessHash: toLong('3333'),
        },
        name: 'Alice Able',
      })
      expect(call).not.toHaveBeenCalled()
    })

    it('still looks up an uncached 10-digit number as a phone', async () => {
      const { call, client } = throwingClient()

      await expect(resolve('5550000000', client)).rejects.toThrow(
        'Could not resolve phone number 5550000000',
      )
      expect(call).toHaveBeenCalledTimes(1)
      expect(call.mock.calls[0]?.[0]).toEqual({
        _: 'contacts.resolvePhone',
        phone: '5550000000',
      })
    })

    it('always takes the phone path for a number with +', async () => {
      cacheChat('15550000000', 'private', 'Bob Baker', '4444')
      const { call, client } = throwingClient()

      await expect(resolve('+15550000000', client)).rejects.toThrow(
        'Could not resolve phone number +15550000000',
      )
      expect(call.mock.calls[0]?.[0]).toEqual({
        _: 'contacts.resolvePhone',
        phone: '15550000000',
      })
    })
  })
})
