/**
 * E2E tests for tg messages pin and unpin, offline: a fake Telegram client
 * that returns the pin update, and made-up chats and messages in the cache
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { takePartIn } from '../__tests__/helpers/participation'
import { dialogToCacheInput } from '../commands/chats/helpers'
import type { PinMessageResult } from '../commands/messages/pin-message'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { createUsersCache } from '../db/users-cache'
import type { MessageSearchItem } from '../types'
import { toPeerIdFromRawPeer } from '../utils/telegram-peer-ids'
import { type CliOptions, NO_CREDENTIALS, runCli } from './helpers/cli'
import {
  FAKE_CLIENT_CALL,
  FAKE_CLIENT_CLI,
  FAKE_PIN_DATE,
  FAKE_PIN_SERVICE_ID,
  FAKE_SELF_ID,
  FAKE_UNPINNABLE_MESSAGE,
} from './helpers/fake-client-cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const ALICE_ID = 10
const BOOK_CLUB_ID = -4242
const TEAM_ID = -1001234567890
const MESSAGE_DATE = 1_760_000_000

const SELF_PEER = { _: 'peerUser', userId: FAKE_SELF_ID } as const
const ALICE_PEER = { _: 'peerUser', userId: ALICE_ID } as const
const TEAM_PEER = { _: 'peerChannel', channelId: 1234567890 } as const

function message(
  peer: typeof SELF_PEER | typeof ALICE_PEER | typeof TEAM_PEER,
  id: number,
  text: string,
  pinned = false,
) {
  return parseRawMessage(
    {
      _: 'message',
      id,
      out: true,
      pinned,
      peerId: peer,
      fromId: SELF_PEER,
      message: text,
      date: MESSAGE_DATE,
    },
    toPeerIdFromRawPeer(peer) as number,
  ) as NonNullable<ReturnType<typeof parseRawMessage>>
}

function seed(db: Database): void {
  createUsersCache(db).upsert({
    user_id: String(ALICE_ID),
    username: 'alice',
    first_name: 'Alice',
    last_name: null,
    access_hash: '777',
    fetched_at: Date.now(),
    raw_json: '{}',
  })
  createChatsCache(db).upsertMany(
    [
      fakeDialog({
        kind: 'user',
        id: ALICE_ID,
        title: 'Alice',
        username: 'alice',
      }),
      fakeDialog({
        kind: 'supergroup',
        id: 1234567890,
        title: 'Team Chat',
        username: 'teamchat',
      }),
      fakeDialog({ kind: 'group', id: 4242, title: 'Book Club' }),
    ].map(dialogToCacheInput),
  )
  takePartIn(db, TEAM_ID, BOOK_CLUB_ID)
  createMessagesCache(db).upsertBatch([
    message(ALICE_PEER, 12, 'See you at nine.'),
    message(ALICE_PEER, 13, 'The address is on the card.', true),
    message(ALICE_PEER, FAKE_UNPINNABLE_MESSAGE, 'Nine works for me.'),
    message(TEAM_PEER, 25, 'Release notes are in the wiki.'),
    message(SELF_PEER, 7, 'Buy oat milk.'),
  ])
}

interface ErrorJson {
  error: {
    code: string
    message: string
    details?: Record<string, unknown>
    retryable: boolean
  }
}

describe('E2E: messages pin and unpin', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('messages-pin')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000000', user_id: FAKE_SELF_ID, is_active: true },
    ])
    seed(env.openCacheDb(1))
  })

  afterEach(() => {
    env.cleanup()
  })

  const offline = (): CliOptions => ({
    env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
  })
  const fake = (): CliOptions => ({
    ...env.getCliOptions(),
    entry: FAKE_CLIENT_CLI,
  })

  function run(
    command: 'pin' | 'unpin',
    chat: string,
    id: number | string,
    { extra = [] as string[], options = fake() } = {},
  ) {
    return runCli(
      ['messages', command, '--chat', chat, '--id', String(id), ...extra],
      options,
    )
  }

  function call(fields: Record<string, unknown>): string {
    return `${FAKE_CLIENT_CALL} ${JSON.stringify({ method: 'messages.updatePinnedMessage', ...fields })}`
  }

  /** The message as the cache holds it, read without Telegram */
  async function cached(chat: string, id: number): Promise<MessageSearchItem> {
    const result = await runCli(
      ['messages', 'get', '--chat', chat, '--id', String(id)],
      offline(),
    )
    expect(result.exitCode).toBe(0)
    return (result.json as { data: { message: MessageSearchItem } }).data
      .message
  }

  it('pins a message in a private chat, prints it and stores the flag', async () => {
    const result = await run('pin', '@alice', 12)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(call({ id: 12 }))
    const data = (result.json as { data: PinMessageResult }).data
    expect(data).toMatchObject({
      chatId: ALICE_ID,
      messageId: 12,
      pinned: true,
      message: {
        chatId: ALICE_ID,
        messageId: 12,
        text: 'See you at nine.',
        isPinned: true,
        chat: { id: ALICE_ID, username: 'alice' },
      },
    })
    expect(await cached('@alice', 12)).toEqual(
      data.message as MessageSearchItem,
    )
  })

  it('unpins a pinned message without a notification flag', async () => {
    const result = await run('unpin', '@alice', 13)

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(call({ id: 13, unpin: true }))
    expect((result.json as { data: PinMessageResult }).data).toMatchObject({
      chatId: ALICE_ID,
      messageId: 13,
      pinned: false,
      message: { messageId: 13, isPinned: false },
    })
    expect((await cached('@alice', 13)).isPinned).toBe(false)
  })

  it.each([
    ['supergroup', '@teamchat', TEAM_ID, 25],
    ['Saved Messages', 'me', FAKE_SELF_ID, 7],
  ])('pins and unpins a message in a %s', async (_kind, chat, chatId, id) => {
    const pin = await run('pin', chat, id)
    expect(pin.exitCode).toBe(0)
    expect((pin.json as { data: PinMessageResult }).data).toMatchObject({
      chatId,
      messageId: id,
      pinned: true,
      message: { chatId, messageId: id, isPinned: true },
    })
    expect((await cached(chat, id)).isPinned).toBe(true)

    const unpin = await run('unpin', chat, id)
    expect(unpin.exitCode).toBe(0)
    expect((unpin.json as { data: PinMessageResult }).data).toMatchObject({
      pinned: false,
      message: { isPinned: false },
    })
    expect((await cached(chat, id)).isPinned).toBe(false)
  })

  it('stores the service message a pin in a supergroup returns', async () => {
    await run('pin', '@teamchat', 25)

    expect(await cached('@teamchat', FAKE_PIN_SERVICE_ID)).toMatchObject({
      chatId: TEAM_ID,
      messageId: FAKE_PIN_SERVICE_ID,
      messageType: 'service',
      action: { type: 'pin_message', messageId: 25 },
      isOutgoing: true,
      date: FAKE_PIN_DATE,
    })
  })

  it('passes --silent on to Telegram', async () => {
    const result = await run('pin', '@teamchat', 25, { extra: ['--silent'] })

    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain(call({ id: 25, silent: true }))
  })

  it('pins a message the cache does not hold, and prints no message', async () => {
    const result = await run('pin', String(BOOK_CLUB_ID), 3)

    expect(result.exitCode).toBe(0)
    expect((result.json as { data: PinMessageResult }).data).toEqual({
      chatId: BOOK_CLUB_ID,
      messageId: 3,
      pinned: true,
      message: null,
    })
    const missing = await runCli(
      ['messages', 'get', '--chat', String(BOOK_CLUB_ID), '--id', '3'],
      offline(),
    )
    expect(missing.exitCode).not.toBe(0)
  })

  it("reports Telegram's refusal and leaves the cached message as it was", async () => {
    const result = await run('pin', '@alice', FAKE_UNPINNABLE_MESSAGE)

    expect(result.exitCode).toBe(5)
    // The error's JSON follows the fake client's call line on stderr
    const json: ErrorJson = JSON.parse(
      result.stderr.slice(result.stderr.indexOf('{\n')),
    )
    expect(json.error).toEqual({
      code: 'TELEGRAM_ERROR',
      message: 'You do not have permission to pin messages in this chat',
      details: {
        chatId: ALICE_ID,
        messageId: FAKE_UNPINNABLE_MESSAGE,
        telegramError: 'CHAT_ADMIN_REQUIRED',
      },
      retryable: false,
    })
    expect((await cached('@alice', FAKE_UNPINNABLE_MESSAGE)).isPinned).toBe(
      false,
    )
  })

  it('refuses a bad --id before it needs Telegram', async () => {
    const result = await run('unpin', '@alice', '12abc', {
      options: offline(),
    })

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('Invalid --id: 12abc')
  })

  it('needs Telegram', async () => {
    const result = await run('pin', '@alice', 12, { options: offline() })

    expect(result.exitCode).toBe(3)
    expect(result.stderr).toContain('TELEGRAM_API_ID')
    expect((await cached('@alice', 12)).isPinned).toBe(false)
  })
})
