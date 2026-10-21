import type { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'

import { InvalidPeerError, resolvePeer } from '../commands/send/peer-resolver'
import { ConfigError } from '../config'
import { type ChatsCache, createChatsCache } from '../db/chats-cache'
import { createMessagesCache, type MessagesCache } from '../db/messages-cache'
import { createTestCacheDatabase } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import type { ChatType } from '../db/types'
import { createUsersCache, type UsersCache } from '../db/users-cache'
import { toLong } from '../utils/long'
import { RateLimitError } from '../utils/telegram-rate-limits'

function throwingClient(
  failure: () => Error = () => new Error('unexpected API call'),
) {
  const call = mock(async (_request: unknown) => {
    throw failure()
  })
  return { call, client: { call } as unknown as Pick<TelegramClient, 'call'> }
}

/** What Telegram answers for a number no account uses */
const phoneNotOccupied = () => new tl.RpcError(400, 'PHONE_NOT_OCCUPIED')

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
  let messagesCache: MessagesCache

  beforeEach(() => {
    db = createTestCacheDatabase().db
    initSyncSchema(db)
    usersCache = createUsersCache(db)
    chatsCache = createChatsCache(db)
    messagesCache = createMessagesCache(db)
  })

  function cacheMessage(chatId: number) {
    messagesCache.upsert({
      chat_id: chatId,
      message_id: 1,
      from_id: chatId,
      text: 'hi',
      message_type: 'text',
      date: 1_760_000_000,
      raw_json: '{}',
    })
  }

  function resolvedPeer(users: tl.TypeUser[]): tl.contacts.RawResolvedPeer {
    return {
      _: 'contacts.resolvedPeer',
      peer: { _: 'peerUser', userId: 0 },
      users,
      chats: [],
    }
  }

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
    return resolvePeer(
      client,
      identifier,
      usersCache,
      chatsCache,
      messagesCache,
    )
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

    it.each([12, 7_000_000_001])(
      'resolves %p as a user when only its private chat is cached',
      async (userId) => {
        cacheMessage(userId)
        const { call, client } = throwingClient()

        const peer = await resolve(String(userId), client)

        expect(peer).toEqual({
          inputPeer: { _: 'inputPeerUser', userId, accessHash: toLong(0) },
          name: `User ${userId}`,
        })
        expect(call).not.toHaveBeenCalled()
      },
    )

    it('resolves a cached user without an access hash as a user, not a group', async () => {
      usersCache.upsert({
        user_id: '11',
        first_name: 'Bob',
        last_name: 'Baker',
        fetched_at: Date.now(),
        raw_json: '{}',
      })
      const { call, client } = throwingClient()

      const peer = await resolve('11', client)

      expect(peer).toEqual({
        inputPeer: { _: 'inputPeerUser', userId: 11, accessHash: toLong(0) },
        name: 'Bob Baker',
      })
      expect(call).not.toHaveBeenCalled()
    })

    it('still takes an unknown short number as a basic group', async () => {
      cacheMessage(-12)
      const { call, client } = throwingClient()

      const peer = await resolve('12', client)

      expect(peer.inputPeer).toEqual({ _: 'inputPeerChat', chatId: 12 })
      expect(call).not.toHaveBeenCalled()
    })

    it.each(['-12.5', '1e1', '0x10', '12.0', '', '0', '-0', '+1e5'])(
      'rejects the malformed number %p without an API call',
      async (identifier) => {
        cacheChat('12', 'private', 'Alice Able', '1111')
        const { call, client } = throwingClient()

        const failure = resolve(identifier, client)

        await expect(failure).rejects.toBeInstanceOf(InvalidPeerError)
        await expect(failure).rejects.toThrow(
          `Invalid peer identifier: ${identifier}`,
        )
        expect(call).not.toHaveBeenCalled()
      },
    )

    it('still looks up an uncached 10-digit number as a phone', async () => {
      const { call, client } = throwingClient(phoneNotOccupied)

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
      const { call, client } = throwingClient(phoneNotOccupied)

      await expect(resolve('+15550000000', client)).rejects.toThrow(
        'Could not resolve phone number +15550000000',
      )
      expect(call.mock.calls[0]?.[0]).toEqual({
        _: 'contacts.resolvePhone',
        phone: '15550000000',
      })
    })

    it.each(['+1 (555) 000-0000', '+1-555-000-0000', '+1 555 000 0000'])(
      'looks up %p as a phone number, not a username',
      async (identifier) => {
        const { call, client } = throwingClient(phoneNotOccupied)

        await expect(resolve(identifier, client)).rejects.toThrow(
          `Could not resolve phone number ${identifier}`,
        )
        expect(call).toHaveBeenCalledTimes(1)
        expect(call.mock.calls[0]?.[0]).toEqual({
          _: 'contacts.resolvePhone',
          phone: '15550000000',
        })
      },
    )

    it.each(['+', '+alice', '+1 555 abc'])(
      'rejects %p, which has no phone number after +',
      async (identifier) => {
        const { call, client } = throwingClient()

        await expect(resolve(identifier, client)).rejects.toBeInstanceOf(
          InvalidPeerError,
        )
        expect(call).not.toHaveBeenCalled()
      },
    )

    it.each([
      ['@alice', 'contacts.resolveUsername'],
      ['+15550000000', 'contacts.resolvePhone'],
    ])(
      'caches the user Telegram resolves for %p, so its ID hits the cache next',
      async (identifier, method) => {
        const alice: tl.RawUser = {
          _: 'user',
          id: 10,
          firstName: 'Alice',
          lastName: 'Able',
          username: 'alice',
          phone: '15550000000',
          accessHash: toLong('1111'),
        }
        const call = mock(async (request: { _: string }) => {
          expect(request._).toBe(method)
          return resolvedPeer([alice])
        })
        const client = { call } as unknown as Pick<TelegramClient, 'call'>

        await resolve(identifier, client)
        const byId = await resolve('10', throwingClient().client)

        expect(byId).toEqual({
          inputPeer: {
            _: 'inputPeerUser',
            userId: 10,
            accessHash: toLong('1111'),
          },
          name: 'Alice Able',
        })
      },
    )

    it('does not cache a min user', async () => {
      const call = mock(async () =>
        resolvedPeer([
          { _: 'user', id: 10, min: true, firstName: 'Alice' } as tl.RawUser,
        ]),
      )

      await resolve('@alice', { call } as unknown as Pick<
        TelegramClient,
        'call'
      >)

      expect(usersCache.getById('10')).toBeNull()
    })

    it.each([
      [
        'missing credentials',
        () =>
          new ConfigError(
            'TELEGRAM_API_ID environment variable is required',
            [],
          ),
      ],
      [
        'a blocked method',
        () => new RateLimitError('contacts.resolvePhone', 30),
      ],
      ['a FLOOD_WAIT', () => new tl.RpcError(420, 'FLOOD_WAIT_30')],
      ['a lost connection', () => new Error('Connection closed')],
    ])('passes on %s from the phone lookup', async (_name, failure) => {
      const { client } = throwingClient(failure)

      await expect(resolve('+15550000000', client)).rejects.toThrow(
        failure().message,
      )
    })
  })
})
