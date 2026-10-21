/**
 * Tests for caching messages sent with `tg send` (src/commands/send/sent-message-cache.ts)
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { tl } from '@mtcute/bun'

import { dialogToCacheInput } from '../commands/chats/helpers'
import {
  buildSentMessageInputs,
  cacheSentMessage,
  resolveSelfId,
  type SentMessageRequest,
} from '../commands/send/sent-message-cache'
import { createTestDatabase } from '../db'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { toLong } from '../utils/long'
import { toPeerIdFromInputPeer } from '../utils/telegram-peer-ids'
import { fakeDialog } from './helpers/fake-dialogs'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'

const SELF_ID = 5550001
const OTHER_USER_ID = 5550002
const GROUP_ID = 4440001
const GROUP_PEER_ID = -4440001
const CHANNEL_ID = 3330001
const CHANNEL_PEER_ID = -1000003330001
const DATE = 1_760_000_000

function shortSent(
  overrides: Partial<tl.RawUpdateShortSentMessage> = {},
): tl.RawUpdateShortSentMessage {
  return {
    _: 'updateShortSentMessage',
    out: true,
    id: 101,
    pts: 2001,
    ptsCount: 1,
    date: DATE,
    ...overrides,
  }
}

function rawMessage(overrides: Partial<tl.RawMessage> = {}): tl.RawMessage {
  return {
    _: 'message',
    id: 202,
    out: true,
    peerId: { _: 'peerChannel', channelId: CHANNEL_ID },
    fromId: { _: 'peerUser', userId: SELF_ID },
    date: DATE,
    message: 'hello channel',
    ...overrides,
  }
}

function updatesWith(
  updates: tl.TypeUpdate[],
  kind: 'updates' | 'updatesCombined' = 'updates',
): tl.TypeUpdates {
  if (kind === 'updatesCombined') {
    return {
      _: 'updatesCombined',
      updates,
      users: [],
      chats: [],
      date: DATE,
      seqStart: 0,
      seq: 0,
    }
  }
  return { _: 'updates', updates, users: [], chats: [], date: DATE, seq: 0 }
}

const selfRequest: SentMessageRequest = {
  peer: { _: 'inputPeerSelf' },
  text: 'note to self',
}

describe('toPeerIdFromInputPeer', () => {
  it('returns marked peer IDs for every input peer type', () => {
    expect(toPeerIdFromInputPeer({ _: 'inputPeerSelf' }, SELF_ID)).toBe(SELF_ID)
    expect(toPeerIdFromInputPeer({ _: 'inputPeerSelf' }, null)).toBeNull()
    expect(
      toPeerIdFromInputPeer(
        {
          _: 'inputPeerUser',
          userId: OTHER_USER_ID,
          accessHash: toLong(1),
        },
        SELF_ID,
      ),
    ).toBe(OTHER_USER_ID)
    expect(
      toPeerIdFromInputPeer({ _: 'inputPeerChat', chatId: GROUP_ID }, null),
    ).toBe(GROUP_PEER_ID)
    expect(
      toPeerIdFromInputPeer(
        {
          _: 'inputPeerChannel',
          channelId: CHANNEL_ID,
          accessHash: toLong(1),
        },
        null,
      ),
    ).toBe(CHANNEL_PEER_ID)
    expect(toPeerIdFromInputPeer({ _: 'inputPeerEmpty' }, SELF_ID)).toBeNull()
  })
})

describe('buildSentMessageInputs', () => {
  describe('updateShortSentMessage', () => {
    it('builds the row from the request for Saved Messages', () => {
      const result = shortSent()
      const [input] = buildSentMessageInputs(result, selfRequest, SELF_ID)

      expect(input).toMatchObject({
        chat_id: SELF_ID,
        message_id: 101,
        from_id: SELF_ID,
        text: 'note to self',
        message_type: 'text',
        has_media: false,
        is_outgoing: true,
        date: DATE,
        reply_to_id: null,
      })
      expect(JSON.parse(input!.raw_json)).toMatchObject({
        _: 'updateShortSentMessage',
        id: 101,
      })
    })

    it('uses the user ID for a private chat', () => {
      const [input] = buildSentMessageInputs(
        shortSent(),
        {
          peer: {
            _: 'inputPeerUser',
            userId: OTHER_USER_ID,
            accessHash: toLong(42),
          },
          text: 'hi',
        },
        SELF_ID,
      )
      expect(input?.chat_id).toBe(OTHER_USER_ID)
      expect(input?.from_id).toBe(SELF_ID)
    })

    it('uses a negative ID for a basic group and keeps the reply', () => {
      const [input] = buildSentMessageInputs(
        shortSent({ id: 7 }),
        {
          peer: { _: 'inputPeerChat', chatId: GROUP_ID },
          text: 'reply',
          replyTo: 5,
        },
        SELF_ID,
      )
      expect(input).toMatchObject({
        chat_id: GROUP_PEER_ID,
        message_id: 7,
        reply_to_id: 5,
      })
    })

    it('records media from the response, such as a link preview', () => {
      const [input] = buildSentMessageInputs(
        shortSent({
          media: {
            _: 'messageMediaWebPage',
            webpage: { _: 'webPageEmpty', id: toLong(9) },
          },
        }),
        { ...selfRequest, text: 'see https://example.com' },
        SELF_ID,
      )
      expect(input).toMatchObject({ message_type: 'webpage', has_media: true })
    })

    it('stores nothing without the own user ID', () => {
      expect(buildSentMessageInputs(shortSent(), selfRequest, null)).toEqual([])
    })
  })

  describe('updates and updatesCombined', () => {
    it('maps updateNewChannelMessage to a -100… chat ID', () => {
      const message = rawMessage()
      const result = updatesWith([
        { _: 'updateMessageID', id: 202, randomId: toLong(1) },
        { _: 'updateNewChannelMessage', message, pts: 1, ptsCount: 1 },
      ])
      const inputs = buildSentMessageInputs(
        result,
        {
          peer: {
            _: 'inputPeerChannel',
            channelId: CHANNEL_ID,
            accessHash: toLong(1),
          },
          text: 'hello channel',
        },
        null,
      )

      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({
        chat_id: CHANNEL_PEER_ID,
        message_id: 202,
        from_id: SELF_ID,
        text: 'hello channel',
        is_outgoing: true,
        date: DATE,
      })
      expect(JSON.parse(inputs[0]!.raw_json)).toMatchObject({
        _: 'message',
        id: 202,
      })
    })

    it('stores a channel that posts as itself under its marked ID', () => {
      const message = rawMessage({
        fromId: { _: 'peerChannel', channelId: CHANNEL_ID },
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerChat', chatId: GROUP_ID },
          date: DATE - 60,
        },
      })
      const [input] = buildSentMessageInputs(
        updatesWith([
          { _: 'updateNewChannelMessage', message, pts: 1, ptsCount: 1 },
        ]),
        selfRequest,
        null,
      )

      expect(input).toMatchObject({
        chat_id: CHANNEL_PEER_ID,
        from_id: CHANNEL_PEER_ID,
        forward_from_id: GROUP_PEER_ID,
      })
    })

    it('maps updateNewMessage in updatesCombined for a basic group', () => {
      const message = rawMessage({
        id: 303,
        peerId: { _: 'peerChat', chatId: GROUP_ID },
        message: 'hello group',
      })
      const inputs = buildSentMessageInputs(
        updatesWith(
          [{ _: 'updateNewMessage', message, pts: 1, ptsCount: 1 }],
          'updatesCombined',
        ),
        { peer: { _: 'inputPeerChat', chatId: GROUP_ID }, text: 'hello group' },
        null,
      )
      expect(inputs).toHaveLength(1)
      expect(inputs[0]).toMatchObject({
        chat_id: GROUP_PEER_ID,
        message_id: 303,
      })
    })

    it('maps a Saved Messages updateNewMessage to the own user ID', () => {
      // Telegram returns Saved Messages with out=false and no fromId
      const message = rawMessage({
        id: 404,
        out: false,
        fromId: undefined,
        peerId: { _: 'peerUser', userId: SELF_ID },
        savedPeerId: { _: 'peerUser', userId: SELF_ID },
      })
      const [input] = buildSentMessageInputs(
        updatesWith([{ _: 'updateNewMessage', message, pts: 1, ptsCount: 1 }]),
        selfRequest,
        null,
      )
      // Same row the sync worker would store for this message
      expect(input).toMatchObject({
        chat_id: SELF_ID,
        message_id: 404,
        from_id: null,
        is_outgoing: false,
      })
    })

    it('ignores updates without a new message', () => {
      const inputs = buildSentMessageInputs(
        updatesWith([{ _: 'updateMessageID', id: 1, randomId: toLong(1) }]),
        selfRequest,
        SELF_ID,
      )
      expect(inputs).toEqual([])
    })
  })
})

describe('cacheSentMessage', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
  })

  it('upserts the message with fetched_at and makes it searchable', async () => {
    const getSelfId = mock(async () => SELF_ID)
    const before = Date.now()

    const cached = await cacheSentMessage(
      { cacheDb: db, getSelfId },
      shortSent(),
      { ...selfRequest, text: 'grocery list sendcachemarker' },
    )

    expect(cached).toBe(1)
    expect(getSelfId).toHaveBeenCalledTimes(1)
    const row = createMessagesCache(db).get(SELF_ID, 101)
    expect(row?.text).toBe('grocery list sendcachemarker')
    expect(row?.is_outgoing).toBe(1)
    expect(row?.fetched_at).toBeGreaterThanOrEqual(before)
    expect(row?.raw_json).toContain('updateShortSentMessage')

    const results = createMessagesSearch(db).search('sendcachemarker')
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ chat_id: SELF_ID, message_id: 101 })
  })

  it('does not look up the own user ID for full updates', async () => {
    const getSelfId = mock(async () => SELF_ID)
    const message = rawMessage()

    const cached = await cacheSentMessage(
      { cacheDb: db, getSelfId },
      updatesWith([
        { _: 'updateNewChannelMessage', message, pts: 1, ptsCount: 1 },
      ]),
      selfRequest,
    )

    expect(cached).toBe(1)
    expect(getSelfId).not.toHaveBeenCalled()
    expect(createMessagesCache(db).get(CHANNEL_PEER_ID, 202)).not.toBeNull()
  })

  it('caches a message sent to a supergroup under the ID its chats_cache row has', async () => {
    createChatsCache(db).upsert(
      dialogToCacheInput(
        fakeDialog({
          kind: 'supergroup',
          id: CHANNEL_ID,
          title: 'Example Team',
          username: 'exampleteam',
        }),
      ),
    )

    await cacheSentMessage(
      { cacheDb: db, getSelfId: async () => SELF_ID },
      updatesWith([
        {
          _: 'updateNewChannelMessage',
          message: rawMessage({ message: 'sendcachemarker for the team' }),
          pts: 1,
          ptsCount: 1,
        },
      ]),
      selfRequest,
    )

    const [hit] = createMessagesSearch(db).search('sendcachemarker')
    expect(hit).toMatchObject({
      chat_id: CHANNEL_PEER_ID,
      chat_title: 'Example Team',
      chat_username: 'exampleteam',
      chat_type: 'supergroup',
    })
    // The search index has the chat title too
    expect(createMessagesSearch(db).search('Example Team')).toHaveLength(1)
    assertPeerIdInvariants(db)
  })

  it('swallows a failing cache write', async () => {
    const broken = new Database(':memory:')

    const cached = await cacheSentMessage(
      { cacheDb: broken, getSelfId: async () => SELF_ID },
      shortSent(),
      selfRequest,
    )

    expect(cached).toBe(0)
  })

  it('swallows a failing own user ID lookup', async () => {
    const cached = await cacheSentMessage(
      {
        cacheDb: db,
        getSelfId: async () => {
          throw new Error('network down')
        },
      },
      shortSent(),
      selfRequest,
    )

    expect(cached).toBe(0)
    expect(createMessagesCache(db).countByChatId(SELF_ID)).toBe(0)
  })
})

describe('resolveSelfId', () => {
  type MeResult = Awaited<
    ReturnType<Parameters<typeof resolveSelfId>[0]['getMe']>
  >
  const getMeResult = { id: SELF_ID } as MeResult

  it('reads the user ID from the account row without calling Telegram', async () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({
      phone: '+15550000001',
      user_id: SELF_ID,
      is_active: true,
    })
    const getMe = mock(async () => getMeResult)

    expect(await resolveSelfId({ getMe }, account.id, accountsDb)).toBe(SELF_ID)
    expect(await resolveSelfId({ getMe }, undefined, accountsDb)).toBe(SELF_ID)
    expect(getMe).not.toHaveBeenCalled()
  })

  it('asks Telegram once and saves the user ID when the row lacks it', async () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({
      phone: '+15550000001',
      is_active: true,
    })
    const getMe = mock(async () => getMeResult)

    expect(await resolveSelfId({ getMe }, undefined, accountsDb)).toBe(SELF_ID)
    expect(getMe).toHaveBeenCalledTimes(1)
    expect(accountsDb.getById(account.id)?.user_id).toBe(SELF_ID)
  })
})
