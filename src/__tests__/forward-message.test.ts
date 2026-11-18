/**
 * Tests for forwarding messages (src/commands/messages/forward-message.ts):
 * the request, pairing source IDs with new ones, Telegram's refusals and a
 * response without the copies. The forward itself and the cache write are
 * covered end to end in src/__e2e__/messages-forward.e2e.test.ts.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { type TelegramClient, tl } from '@mtcute/bun'

import {
  ForwardRefusedError,
  forwardMessages,
  forwardMessagesRequest,
  pairForwardedIds,
} from '../commands/messages/forward-message'
import type { HistoryChat } from '../commands/messages/history'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { toLong } from '../utils/long'

const ALICE: HistoryChat = {
  chatId: 10,
  inputPeer: { _: 'inputPeerUser', userId: 10, accessHash: toLong(7) },
}
const BOB: HistoryChat = {
  chatId: 20,
  inputPeer: { _: 'inputPeerUser', userId: 20, accessHash: toLong(8) },
}

function cache(): Database {
  const db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  return db
}

function clientThat(call: () => Promise<unknown>): TelegramClient {
  return { call } as unknown as TelegramClient
}

function refusing(code: number, text: string): TelegramClient {
  return clientThat(async () => {
    throw tl.RpcError.fromTl({
      _: 'rpc_error',
      errorCode: code,
      errorMessage: text,
    })
  })
}

function updates(list: unknown[]): tl.TypeUpdates {
  return {
    _: 'updates',
    updates: list,
    users: [],
    chats: [],
    date: 1_760_000_000,
    seq: 0,
  } as tl.TypeUpdates
}

describe('forwardMessagesRequest', () => {
  it('sends one distinct random ID per message', () => {
    const request = forwardMessagesRequest(
      ALICE.inputPeer,
      BOB.inputPeer,
      [12, 13, 14],
    )

    expect(request).toMatchObject({
      _: 'messages.forwardMessages',
      fromPeer: ALICE.inputPeer,
      toPeer: BOB.inputPeer,
      id: [12, 13, 14],
    })
    expect(new Set(request.randomId.map(String)).size).toBe(3)
  })
})

describe('pairForwardedIds', () => {
  const request = {
    id: [14, 12, 13],
    randomId: [toLong(1), toLong(2), toLong(3)],
  }

  it('maps each source ID to its new ID through its random ID', () => {
    const result = updates([
      { _: 'updateMessageID', id: 31, randomId: toLong(2) },
      { _: 'updateMessageID', id: 32, randomId: toLong(3) },
      { _: 'updateMessageID', id: 33, randomId: toLong(1) },
    ])

    expect(pairForwardedIds(request, result)).toEqual([33, 31, 32])
  })

  it('reports null for a message without updateMessageID, and guesses nothing', () => {
    const result = updates([
      { _: 'updateMessageID', id: 31, randomId: toLong(2) },
    ])

    expect(pairForwardedIds(request, result)).toEqual([null, 31, null])
    expect(pairForwardedIds(request, { _: 'updatesTooLong' })).toEqual([
      null,
      null,
      null,
    ])
  })
})

describe('forwardMessages', () => {
  it.each([
    [
      'CHAT_FORWARDS_RESTRICTED',
      406,
      'The source chat protects its content: Telegram does not allow forwarding from it',
    ],
    [
      'MESSAGE_ID_INVALID',
      400,
      'Telegram has no message with this ID in the source chat',
    ],
    [
      'MESSAGE_IDS_EMPTY',
      400,
      'Telegram found none of these messages in the source chat',
    ],
    [
      'CHAT_WRITE_FORBIDDEN',
      403,
      'You do not have permission to post in the target chat',
    ],
    [
      'CHAT_SEND_PHOTOS_FORBIDDEN',
      403,
      'The target chat does not allow this kind of message (photos)',
    ],
    ['USER_IS_BLOCKED', 403, 'The recipient has blocked you'],
    [
      'YOU_BLOCKED_USER',
      400,
      'You blocked the recipient: unblock them to forward to them',
    ],
    [
      'PEER_ID_INVALID',
      400,
      'Telegram does not know one of these chats: run tg chats list --fresh or pass the @username',
    ],
  ])(
    'turns %s into a refusal that says what is wrong',
    async (name, code, message) => {
      const err = await forwardMessages(
        refusing(code, name),
        cache(),
        ALICE,
        BOB,
        [12, 13],
      ).catch((e: unknown) => e)

      expect(err).toBeInstanceOf(ForwardRefusedError)
      expect((err as ForwardRefusedError).message).toBe(message)
      expect((err as ForwardRefusedError).details).toEqual({
        fromChatId: 10,
        toChatId: 20,
        messageIds: [12, 13],
        telegramError: name,
      })
    },
  )

  it('passes any other Telegram error on, with the hint for an unknown chat', async () => {
    await expect(
      forwardMessages(
        refusing(400, 'CHANNEL_INVALID'),
        cache(),
        ALICE,
        BOB,
        [12],
      ),
    ).rejects.toThrow('tg chats list --fresh')
    await expect(
      forwardMessages(refusing(500, 'INTERNAL'), cache(), ALICE, BOB, [12]),
    ).rejects.not.toBeInstanceOf(ForwardRefusedError)
  })

  it('reports the new ID without a message when the response holds no copy', async () => {
    const client = clientThat(async (...args: unknown[]) => {
      const request = args[0] as tl.messages.RawForwardMessagesRequest
      return updates([
        { _: 'updateMessageID', id: 31, randomId: request.randomId[0] },
      ])
    })

    expect(await forwardMessages(client, cache(), ALICE, BOB, [12])).toEqual({
      fromChatId: 10,
      toChatId: 20,
      forwarded: [{ messageId: 12, newMessageId: 31, message: null }],
    })
  })
})
