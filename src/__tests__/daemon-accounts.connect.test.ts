/**
 * Additional tests for daemon account connection + event wiring
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import type {
  DeleteMessageUpdate,
  Message,
  TelegramClient,
  tl,
} from '@mtcute/bun'
import * as mtcute from '@mtcute/bun'
import {
  createDaemonRuntime,
  type DaemonContext,
} from '../daemon/daemon-context'
import { buildInputPeer } from '../daemon/sync-worker-real-helpers'
import type { AccountConnectionState } from '../daemon/types'
import type { AccountsDbInterface } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import type { Account } from '../types'
import { toLong } from '../utils/long'
import {
  addAccountRuntime,
  createAccountCacheDb,
} from './helpers/daemon-runtime'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'

type AccountCreateInput = Parameters<AccountsDbInterface['create']>[0]
type AccountUpdateInput = Parameters<AccountsDbInterface['update']>[1]
type AccountSeed = Pick<Account, 'id' | 'phone'> & { user_id?: number | null }
type MessageLike = {
  id: number
  chat: {
    id: number
    type: string
    chatType?: string
    membersCount?: number
    raw?: tl.TypeUser | tl.TypeChat
  }
  sender?: { id: number } | null
  text: string
  date: Date
  isOutgoing: boolean
  media?: { type: string } | null
  replyToMessage?: { id: number } | null
  raw?: {
    fwdFrom?: {
      _: string
      fromId?: {
        _: string
        userId?: number
        chatId?: number
        channelId?: number
      }
      date?: number
    }
  }
  editDate?: Date | null
}
type DeleteMessageUpdateLike = {
  channelId: number | null
  messageIds: number[]
}

class MockEvent<TArgs extends unknown[]> {
  handlers: Array<(...args: TArgs) => void> = []
  add = mock((handler: (...args: TArgs) => void) => {
    this.handlers.push(handler)
  })
  remove = mock((handler: (...args: TArgs) => void) => {
    this.handlers = this.handlers.filter((entry) => entry !== handler)
  })
  emit(...args: TArgs) {
    for (const handler of this.handlers) {
      handler(...args)
    }
  }
}

let testCacheDb: Database

// Mutable client behavior
let nextGetMe = { id: 555, firstName: 'Test', lastName: 'User' }
let startError: Error | null = null
let getMeError: Error | null = null
let updatesLoopError: Error | null = null

const createdClients: MockTelegramClient[] = []
// Client lifecycle calls in order, e.g. 'start:0', 'destroy:0'
const lifecycle: string[] = []

class MockTelegramClient {
  options: Record<string, unknown>
  index: number
  onNewMessage = new MockEvent<[Message]>()
  onEditMessage = new MockEvent<[Message]>()
  onDeleteMessage = new MockEvent<[DeleteMessageUpdate]>()

  start = mock(async (_opts?: Parameters<TelegramClient['start']>[0]) => {
    lifecycle.push(`start:${this.index}`)
    if (startError) throw startError
    return {
      id: nextGetMe.id,
      firstName: nextGetMe.firstName,
    } as Awaited<ReturnType<TelegramClient['start']>>
  })
  getMe = mock(async () => {
    if (getMeError) throw getMeError
    return nextGetMe as Awaited<ReturnType<TelegramClient['getMe']>>
  })
  startUpdatesLoop = mock(async () => {
    if (updatesLoopError) throw updatesLoopError
  })
  destroy = mock(async () => {
    lifecycle.push(`destroy:${this.index}`)
  })

  constructor(options: Record<string, unknown>) {
    this.options = options
    this.index = createdClients.length
    createdClients.push(this)
  }
}

const createClient = (): TelegramClient =>
  new MockTelegramClient({}) as unknown as TelegramClient

const asMessage = (input: MessageLike): Message => input as Message
const asDeleteUpdate = (input: DeleteMessageUpdateLike): DeleteMessageUpdate =>
  input as DeleteMessageUpdate

mock.module('@mtcute/bun', () => ({
  ...mtcute,
  TelegramClient: MockTelegramClient,
  networkMiddlewares: {
    basic: (options: unknown) => [{ kind: 'basic', options }],
  },
}))

function createLogger() {
  return {
    info: mock(() => {}),
    debug: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
  }
}

function createAccountsDb(seed: AccountSeed[]): AccountsDbInterface {
  const accounts = new Map<number, Account>()
  let activeId: number | null = null

  for (const acc of seed) {
    accounts.set(acc.id, {
      id: acc.id,
      phone: acc.phone,
      user_id: acc.user_id ?? null,
      name: null,
      username: null,
      label: null,
      session_data: '',
      is_active: 0,
      created_at: '',
      updated_at: '',
    })
  }

  return {
    getAll: () => Array.from(accounts.values()),
    getById: (id: number) => accounts.get(id) ?? null,
    getByPhone: (phone: string) =>
      Array.from(accounts.values()).find((acc) => acc.phone === phone) ?? null,
    getByUserId: (userId: number) =>
      Array.from(accounts.values()).find((acc) => acc.user_id === userId) ??
      null,
    getByUsername: (username: string) =>
      Array.from(accounts.values()).find((acc) => acc.username === username) ??
      null,
    getAllByLabel: (label: string) =>
      Array.from(accounts.values()).filter((acc) => acc.label === label),
    getActive: () => (activeId ? (accounts.get(activeId) ?? null) : null),
    create: (_data: AccountCreateInput) => {
      throw new Error('not used')
    },
    update: mock((id: number, data: AccountUpdateInput) => {
      const current = accounts.get(id)
      if (!current) return null
      const updated = {
        ...current,
        phone: data.phone ?? current.phone,
        user_id: data.user_id !== undefined ? data.user_id : current.user_id,
        name: data.name ?? current.name,
        username: data.username ?? current.username,
        label: data.label ?? current.label,
        session_data: data.session_data ?? current.session_data,
      }
      accounts.set(id, updated)
      return updated
    }),
    updateSession: mock((_id: number, _session: string) => {}),
    setActive: mock((id: number) => {
      activeId = id
      for (const acc of accounts.values()) {
        acc.is_active = acc.id === id ? 1 : 0
      }
    }),
    delete: mock((id: number) => {
      return accounts.delete(id)
    }),
    count: () => accounts.size,
  }
}

/** A context whose accounts all have a runtime on the test cache */
function createContext(accountsDb: AccountsDbInterface): DaemonContext {
  const ctx = createBareContext(accountsDb)
  for (const account of accountsDb.getAll()) {
    addAccountRuntime(ctx, account.id, testCacheDb)
  }
  return ctx
}

function createBareContext(accountsDb: AccountsDbInterface): DaemonContext {
  return {
    dataDir: '/tmp/tgcli',
    pidPath: '/tmp/tgcli.pid',
    verbosity: 'normal',
    reconnectConfig: {
      initialDelayMs: 1000,
      maxDelayMs: 4000,
      maxAttempts: 2,
      backoffMultiplier: 2,
    },
    shutdownTimeoutMs: 1_000_000,
    logger: createLogger(),
    pidFile: {
      acquire: () => {},
      release: () => {},
      read: () => null,
      isRunning: () => false,
      sendSignal: () => false,
      getPath: () => '/tmp/tgcli.pid',
    },
    state: {
      running: true,
      accounts: new Map(),
      shutdownRequested: false,
    },
    accountsDb,
    runtime: createDaemonRuntime(),
  }
}

describe('daemon-accounts: connection + event wiring', () => {
  beforeEach(() => {
    testCacheDb = new Database(':memory:')
    initCacheSchema(testCacheDb)
    initSyncSchema(testCacheDb)

    nextGetMe = { id: 555, firstName: 'Test', lastName: 'User' }
    startError = null
    getMeError = null
    updatesLoopError = null
    createdClients.length = 0
    lifecycle.length = 0
  })

  afterEach(() => {
    testCacheDb.close()
    delete process.env.TELEGRAM_PROXY
  })

  it('registers handlers and persists mapped message fields', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+111', user_id: null },
    ])
    const ctx = createContext(accountsDb)

    const { setupEventHandlers } = await import('../daemon/daemon-accounts')

    const client = createClient()
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'connected',
      client,
    }

    setupEventHandlers(ctx, accountState)

    const now = new Date('2024-01-01T00:00:00Z')
    // mtcute gives the chat and the sender as marked IDs
    const channelId = -1000000001000
    const message = {
      id: 42,
      chat: { id: channelId, type: 'chat', chatType: 'channel' },
      sender: { id: 777 },
      text: 'Photo message',
      date: now,
      isOutgoing: false,
      media: { type: 'photo' },
      replyToMessage: { id: 9 },
      raw: {
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerUser', userId: 333 },
          date: Math.floor(now.getTime() / 1000),
        },
      },
    } satisfies MessageLike

    accountState.eventHandlers?.onNewMessage(asMessage(message))

    const messagesCache = createMessagesCache(testCacheDb)
    const chatSyncState = createChatSyncStateService(testCacheDb)

    const cached = messagesCache.get(channelId, 42)
    expect(cached).not.toBeNull()
    expect(cached?.message_type).toBe('photo')
    expect(cached?.has_media).toBe(1)
    expect(cached?.reply_to_id).toBe(9)
    expect(cached?.forward_from_id).toBe(333)
    expect(JSON.parse(cached?.raw_json ?? '{}').fwdFrom?.fromId?.userId).toBe(
      333,
    )

    const state = chatSyncState.get(channelId)
    expect(state?.chat_type).toBe('channel')
    expect(state?.sync_enabled).toBe(0)
    expect(accountState.lastActivity).toBeDefined()
    expect(client.onNewMessage.add).toHaveBeenCalled()
  })

  it('stores a live forward from a channel or a group under its marked ID', async () => {
    const ctx = createContext(
      createAccountsDb([{ id: 1, phone: '+111', user_id: null }]),
    )
    const { setupEventHandlers } = await import('../daemon/daemon-accounts')
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'connected',
      client: createClient(),
    }
    setupEventHandlers(ctx, accountState)

    const forwarded = (
      id: number,
      fromId: NonNullable<NonNullable<MessageLike['raw']>['fwdFrom']>['fromId'],
    ) =>
      asMessage({
        id,
        chat: { id: 5550001, type: 'user' },
        sender: { id: 5550001 },
        text: 'Forwarded',
        date: new Date('2024-01-01T00:00:00Z'),
        isOutgoing: false,
        raw: {
          fwdFrom: { _: 'messageFwdHeader', fromId, date: 1_704_067_200 },
        },
      })
    accountState.eventHandlers?.onNewMessage(
      forwarded(1, { _: 'peerChannel', channelId: 333 }),
    )
    accountState.eventHandlers?.onNewMessage(
      forwarded(2, { _: 'peerChat', chatId: 222 }),
    )

    const messagesCache = createMessagesCache(testCacheDb)
    expect(messagesCache.get(5550001, 1)?.forward_from_id).toBe(-1000000000333)
    expect(messagesCache.get(5550001, 2)?.forward_from_id).toBe(-222)
    assertPeerIdInvariants(testCacheDb)
  })

  it('stores the sender a history page stores for a message without fromId (#44)', async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: '+111' }]))
    const { setupEventHandlers } = await import('../daemon/daemon-accounts')
    const { cacheHistoryResponse } = await import(
      '../commands/messages/history'
    )
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'connected',
      client: createClient(),
    }
    setupEventHandlers(ctx, accountState)

    const date = 1_704_067_200
    const alice: tl.RawUser = {
      _: 'user',
      id: 5550001,
      firstName: 'Alice',
      accessHash: toLong('1111'),
    }
    const self: tl.RawUser = {
      _: 'user',
      id: 5550099,
      self: true,
      firstName: 'Me',
      accessHash: toLong('9999'),
    }
    const news: tl.RawChannel = {
      _: 'channel',
      id: 1234567890,
      title: 'Example News',
      broadcast: true,
      accessHash: toLong('2222'),
      photo: { _: 'chatPhotoEmpty' },
      date,
    }
    const bookClub: tl.RawChat = {
      _: 'chat',
      id: 4242,
      title: 'Book Club',
      photo: { _: 'chatPhotoEmpty' },
      participantsCount: 5,
      date,
      version: 1,
    }
    // Telegram leaves fromId out of all but the outgoing message
    const messages: Array<tl.RawMessage | tl.RawMessageService> = [
      {
        _: 'message',
        id: 1,
        peerId: { _: 'peerUser', userId: alice.id },
        date,
        message: 'incoming',
      },
      {
        _: 'message',
        id: 2,
        post: true,
        peerId: { _: 'peerChannel', channelId: news.id },
        date,
        message: 'channel post',
      },
      {
        _: 'message',
        id: 3,
        peerId: { _: 'peerUser', userId: self.id },
        date,
        message: 'saved',
      },
      {
        _: 'message',
        id: 4,
        out: true,
        fromId: { _: 'peerUser', userId: self.id },
        peerId: { _: 'peerUser', userId: alice.id },
        date,
        message: 'outgoing',
      },
      {
        _: 'messageService',
        id: 5,
        peerId: { _: 'peerChat', chatId: bookClub.id },
        date,
        action: { _: 'messageActionChatEditTitle', title: 'Book Club' },
      },
    ]
    const peers = mtcute.PeersIndex.from({
      users: [alice, self],
      chats: [news, bookClub],
    })
    const historyDb = new Database(':memory:')
    initCacheSchema(historyDb)
    initSyncSchema(historyDb)

    const senders = messages.map((raw) => {
      const msg = new mtcute.Message(raw, peers)
      accountState.eventHandlers?.onNewMessage(msg)
      cacheHistoryResponse(historyDb, msg.chat.id, [raw], [alice, self], {})
      const live = createMessagesCache(testCacheDb).get(msg.chat.id, msg.id)
      const history = createMessagesCache(historyDb).get(msg.chat.id, msg.id)
      return [live?.from_id, history?.from_id, msg.sender.id]
    })
    historyDb.close()

    expect(senders).toEqual([
      [5550001, 5550001, 5550001],
      [-1001234567890, -1001234567890, -1001234567890],
      [5550099, 5550099, 5550099],
      [5550099, 5550099, 5550099],
      [-4242, -4242, -4242],
    ])
  })

  it('passes a live group message member count to the sync policy', async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: '+111' }]))
    const { setupEventHandlers } = await import('../daemon/daemon-accounts')
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'connected',
      client: createClient(),
    }
    setupEventHandlers(ctx, accountState)

    accountState.eventHandlers?.onNewMessage(
      asMessage({
        id: 1,
        chat: { id: -4001, type: 'chat', chatType: 'group', membersCount: 10 },
        sender: { id: 777 },
        text: 'Hi all',
        date: new Date('2024-01-01T00:00:00Z'),
        isOutgoing: false,
      }),
    )

    const state = createChatSyncStateService(testCacheDb).get(-4001)
    expect(state?.member_count).toBe(10)
    expect(state?.sync_enabled).toBe(1)
  })

  it('caches the chat of a live message from a chat no dialog pass listed', async () => {
    const ctx = createContext(createAccountsDb([{ id: 1, phone: '+111' }]))
    const { setupEventHandlers } = await import('../daemon/daemon-accounts')
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'connected',
      client: createClient(),
    }
    setupEventHandlers(ctx, accountState)

    const chatsCache = createChatsCache(testCacheDb)
    expect(chatsCache.getById('5550001')).toBeNull()

    accountState.eventHandlers?.onNewMessage(
      asMessage({
        id: 1,
        chat: {
          id: 5550001,
          type: 'user',
          raw: {
            _: 'user',
            id: 5550001,
            accessHash: toLong(777),
            firstName: 'Alex',
          } as tl.RawUser,
        },
        sender: { id: 5550001 },
        text: 'Hello',
        date: new Date('2024-01-01T00:00:00Z'),
        isOutgoing: false,
      }),
    )

    // The first page of this DM builds its InputPeer from this row
    expect(chatsCache.getById('5550001')?.access_hash).toBe('777')
    expect(buildInputPeer(5550001, chatsCache)).toEqual({
      _: 'inputPeerUser',
      userId: 5550001,
      accessHash: toLong(777),
    })
  })

  it('handles delete updates without chat context', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+111', user_id: null },
    ])
    const ctx = createContext(accountsDb)

    const { setupEventHandlers } = await import('../daemon/daemon-accounts')

    const client = createClient()
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'connected',
      client,
    }

    setupEventHandlers(ctx, accountState)

    const messagesCache = createMessagesCache(testCacheDb)
    messagesCache.upsert({
      chat_id: 100,
      message_id: 1,
      text: 'One',
      message_type: 'text',
      date: Date.now(),
      raw_json: '{}',
    })
    messagesCache.upsert({
      chat_id: 200,
      message_id: 2,
      text: 'Two',
      message_type: 'text',
      date: Date.now(),
      raw_json: '{}',
    })

    const deleteUpdate = {
      channelId: null,
      messageIds: [1, 2],
    } satisfies DeleteMessageUpdateLike

    accountState.eventHandlers?.onDeleteMessage(asDeleteUpdate(deleteUpdate))

    expect(messagesCache.get(100, 1)?.is_deleted).toBe(1)
    expect(messagesCache.get(200, 2)?.is_deleted).toBe(1)
  })

  it('merges duplicate user_id by keeping real phone account', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: 'user:555', user_id: 555 },
      { id: 2, phone: '+1999', user_id: null },
    ])
    const ctx = createContext(accountsDb)

    nextGetMe = { id: 555, firstName: 'Test', lastName: 'User' }

    const { connectAccount } = await import('../daemon/daemon-accounts')

    const connected = await connectAccount(ctx, 2, '+1999', null)

    expect(connected).toBe(true)
    expect(accountsDb.delete).toHaveBeenCalledWith(1)
    expect(accountsDb.update).toHaveBeenCalledWith(2, { user_id: 555 })
    const account = accountsDb.getById(2)
    expect(account?.user_id).toBe(555)
    expect(createdClients[0]?.startUpdatesLoop).toHaveBeenCalled()
    // The removed account stops running; its cache files stay
    expect(ctx.runtime.accounts.has(1)).toBe(false)
    expect(ctx.runtime.accounts.has(2)).toBe(true)
  })

  it('waits out long FLOOD_WAITs instead of failing daemon requests', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+111', user_id: null },
    ])
    const ctx = createContext(accountsDb)

    const { connectAccount } = await import('../daemon/daemon-accounts')

    expect(await connectAccount(ctx, 1, '+111', null)).toBe(true)

    const network = createdClients[0]?.options.network as {
      middlewares: Array<{ options: { floodWaiter: { maxWait: number } } }>
    }
    expect(network.middlewares[0]?.options.floodWaiter.maxWait).toBe(300_000)
    expect(createdClients[0]?.options).not.toHaveProperty('transport')
  })

  it('daemon clients use the daemon platform', async () => {
    const ctx = createContext(
      createAccountsDb([{ id: 1, phone: '+15550000001', user_id: 555 }]),
    )
    const { attemptReconnect, connectAccount } = await import(
      '../daemon/daemon-accounts'
    )
    const { daemonPlatform } = await import('../daemon/daemon-platform')

    expect(await connectAccount(ctx, 1, '+15550000001', null)).toBe(true)
    const accountState = ctx.state.accounts.get(1)!
    accountState.status = 'error'
    expect(await attemptReconnect(ctx, accountState)).toBe(true)

    // Session files stay open until the daemon closes the client (#56)
    expect(createdClients).toHaveLength(2)
    for (const client of createdClients) {
      expect(client.options.platform).toBe(daemonPlatform)
    }
  })

  it('uses the proxy transport when connecting an account', async () => {
    process.env.TELEGRAM_PROXY = 'socks5://127.0.0.1:1080'
    const ctx = createContext(
      createAccountsDb([{ id: 1, phone: '+15550000000', user_id: null }]),
    )
    const { connectAccount } = await import('../daemon/daemon-accounts')
    expect(await connectAccount(ctx, 1, '+15550000000', null)).toBe(true)
    expect(createdClients[0]?.options.transport).toEqual(
      mtcute.proxyTransportFromUrl(process.env.TELEGRAM_PROXY),
    )
  })

  it('merges duplicate user_id by keeping existing real phone account', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+1555', user_id: 555 },
      { id: 2, phone: 'user:555', user_id: null },
    ])
    const ctx = createContext(accountsDb)

    nextGetMe = { id: 555, firstName: 'Test', lastName: 'User' }

    const { connectAccount } = await import('../daemon/daemon-accounts')

    const connected = await connectAccount(ctx, 2, 'user:555', null)

    expect(connected).toBe(false)
    expect(accountsDb.setActive).toHaveBeenCalledWith(1)
    expect(accountsDb.delete).toHaveBeenCalledWith(2)
    expect(ctx.state.accounts.has(2)).toBe(false)
    expect(createdClients[0]?.destroy).toHaveBeenCalledTimes(1)
    expect(ctx.runtime.accounts.has(2)).toBe(false)
    expect(ctx.runtime.accounts.has(1)).toBe(true)

    const { disconnectAllAccounts } = await import('../daemon/daemon-accounts')
    await disconnectAllAccounts(ctx)
    expect(createdClients[0]?.destroy).toHaveBeenCalledTimes(1)
  })

  for (const step of ['start', 'getMe', 'updates loop'] as const) {
    it(`connectAccount closes the client when ${step} fails`, async () => {
      const ctx = createContext(
        createAccountsDb([{ id: 1, phone: '+15550000001', user_id: null }]),
      )
      const { connectAccount, disconnectAllAccounts } = await import(
        '../daemon/daemon-accounts'
      )

      const failure = new Error('AUTH_KEY_UNREGISTERED')
      if (step === 'start') startError = failure
      if (step === 'getMe') getMeError = failure
      if (step === 'updates loop') updatesLoopError = failure

      expect(await connectAccount(ctx, 1, '+15550000001', null)).toBe(false)

      const client = createdClients[0]!
      const accountState = ctx.state.accounts.get(1)
      expect(client.destroy).toHaveBeenCalledTimes(1)
      expect(client.onNewMessage.handlers).toHaveLength(0)
      expect(accountState?.client).toBeUndefined()
      expect(accountState?.eventHandlers).toBeUndefined()
      expect(accountState?.status).toBe('error')
      expect(accountState?.lastError).toBe('AUTH_KEY_UNREGISTERED')

      // Shutdown doesn't close it a second time
      await disconnectAllAccounts(ctx)
      expect(client.destroy).toHaveBeenCalledTimes(1)
    })
  }

  it('disconnectAllAccounts closes every client once on shutdown', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+15550000001', user_id: null },
      { id: 2, phone: '+15550000002', user_id: null },
      { id: 3, phone: '+15550000003', user_id: null },
    ])
    const ctx = createContext(accountsDb)
    const { connectAccount, disconnectAllAccounts } = await import(
      '../daemon/daemon-accounts'
    )

    nextGetMe = { id: 5550001, firstName: 'Alex', lastName: 'Example' }
    expect(await connectAccount(ctx, 1, '+15550000001', null)).toBe(true)
    nextGetMe = { id: 5550002, firstName: 'Sam', lastName: 'Example' }
    expect(await connectAccount(ctx, 2, '+15550000002', null)).toBe(true)
    startError = new Error('connection refused')
    expect(await connectAccount(ctx, 3, '+15550000003', null)).toBe(false)

    expect(createdClients).toHaveLength(3)
    expect(createdClients[0]!.destroy).not.toHaveBeenCalled()
    expect(createdClients[1]!.destroy).not.toHaveBeenCalled()

    await disconnectAllAccounts(ctx)

    for (const client of createdClients) {
      expect(client.destroy).toHaveBeenCalledTimes(1)
      expect(client.onNewMessage.handlers).toHaveLength(0)
      expect(client.onEditMessage.handlers).toHaveLength(0)
      expect(client.onDeleteMessage.handlers).toHaveLength(0)
    }
    for (const accountState of ctx.state.accounts.values()) {
      expect(accountState.status).toBe('disconnected')
      expect(accountState.client).toBeUndefined()
      expect(accountState.eventHandlers).toBeUndefined()
    }

    // A second call finds nothing left to close
    await disconnectAllAccounts(ctx)
    for (const client of createdClients) {
      expect(client.destroy).toHaveBeenCalledTimes(1)
    }
  })

  it('releaseClient keeps the update handlers until destroy() returns', async () => {
    const ctx = createContext(
      createAccountsDb([{ id: 1, phone: '+15550000001', user_id: null }]),
    )
    const { connectAccount, disconnectAllAccounts } = await import(
      '../daemon/daemon-accounts'
    )
    expect(await connectAccount(ctx, 1, '+15550000001', null)).toBe(true)

    // The updates loop dispatches the batch it was handling when destroy()
    // stopped it
    const client = createdClients[0]!
    let handlersDuringDestroy = -1
    client.destroy.mockImplementation(async () => {
      handlersDuringDestroy = client.onNewMessage.handlers.length
      client.onNewMessage.emit(
        asMessage({
          id: 9,
          chat: { id: 5550002, type: 'user' },
          sender: { id: 5550002 },
          text: 'sent as the daemon stopped',
          date: new Date('2026-01-02T12:00:00Z'),
          isOutgoing: false,
        }),
      )
    })

    await disconnectAllAccounts(ctx)

    expect(handlersDuringDestroy).toBe(1)
    expect(createMessagesCache(testCacheDb).get(5550002, 9)?.text).toBe(
      'sent as the daemon stopped',
    )
    expect(client.onNewMessage.handlers).toHaveLength(0)
    expect(client.onEditMessage.handlers).toHaveLength(0)
    expect(client.onDeleteMessage.handlers).toHaveLength(0)
    expect(ctx.state.accounts.get(1)?.eventHandlers).toBeUndefined()
  })

  it('disconnectAllAccounts closes the other clients when one fails to close', async () => {
    const ctx = createContext(
      createAccountsDb([
        { id: 1, phone: '+15550000001', user_id: null },
        { id: 2, phone: '+15550000002', user_id: null },
      ]),
    )
    const { connectAccount, disconnectAllAccounts } = await import(
      '../daemon/daemon-accounts'
    )

    nextGetMe = { id: 5550001, firstName: 'Alex', lastName: 'Example' }
    expect(await connectAccount(ctx, 1, '+15550000001', null)).toBe(true)
    nextGetMe = { id: 5550002, firstName: 'Sam', lastName: 'Example' }
    expect(await connectAccount(ctx, 2, '+15550000002', null)).toBe(true)

    // Session files stay open until destroy(), so a closed one is a fault
    // worth a warning, not an expected part of the stop (#56)
    createdClients[0]!.destroy.mockImplementation(async () => {
      throw new Error('Database has closed')
    })

    await disconnectAllAccounts(ctx)

    expect(createdClients[0]!.destroy).toHaveBeenCalledTimes(1)
    expect(createdClients[1]!.destroy).toHaveBeenCalledTimes(1)
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to close client (shutdown): Error: Database has closed',
      ),
    )
    expect(ctx.logger.debug).not.toHaveBeenCalledWith(
      expect.stringContaining('already closed'),
    )
    expect(ctx.state.accounts.get(1)?.status).toBe('disconnected')
    expect(ctx.state.accounts.get(2)?.status).toBe('disconnected')
  })

  it('attemptReconnect resets attempts on success', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+111', user_id: 555 },
    ])
    const ctx = createContext(accountsDb)

    const { attemptReconnect } = await import('../daemon/daemon-accounts')

    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'error',
      reconnectAttempts: 2,
    }

    const ok = await attemptReconnect(ctx, accountState)

    expect(ok).toBe(true)
    expect(accountState.status).toBe('connected')
    expect(accountState.reconnectAttempts).toBe(0)
    expect(accountState.lastError).toBeUndefined()
    expect(accountState.client).toBeDefined()
  })

  it('attemptReconnect schedules retry on failure', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+111', user_id: 555 },
    ])
    const ctx = createContext(accountsDb)

    const { attemptReconnect } = await import('../daemon/daemon-accounts')

    startError = new Error('boom')

    const now = Date.now()
    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+111',
      name: null,
      status: 'error',
      reconnectAttempts: 0,
    }

    const ok = await attemptReconnect(ctx, accountState)

    expect(ok).toBe(false)
    expect(accountState.status).toBe('error')
    expect(accountState.lastError).toBe('boom')
    expect(accountState.nextReconnectAt).toBeGreaterThan(now)
    expect(accountState.client).toBeUndefined()
    expect(createdClients[0]?.destroy).toHaveBeenCalledTimes(1)
  })

  it('attemptReconnect restores real-time updates and sync on a new client', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+15550000001', user_id: 555 },
    ])
    const ctx = createContext(accountsDb)

    const { attemptReconnect, connectAccount } = await import(
      '../daemon/daemon-accounts'
    )
    const { initializeScheduler } = await import('../daemon/daemon-scheduler')

    expect(await connectAccount(ctx, 1, '+15550000001', null)).toBe(true)
    await initializeScheduler(ctx)

    const oldClient = createdClients[0]!
    const oldWorker = ctx.runtime.accounts.get(1)?.worker
    expect(oldClient.onNewMessage.handlers).toHaveLength(1)
    expect(oldWorker?.client).toBe(oldClient as unknown as TelegramClient)

    // What a failed health check leaves behind
    const accountState = ctx.state.accounts.get(1)!
    accountState.status = 'error'

    expect(await attemptReconnect(ctx, accountState)).toBe(true)

    expect(createdClients).toHaveLength(2)
    const newClient = createdClients[1]!
    const reconnected = ctx.state.accounts.get(1)
    expect(reconnected?.client).toBe(newClient as unknown as TelegramClient)
    expect(reconnected?.status).toBe('connected')

    // The old client is detached and closed before the new one opens the session
    expect(oldClient.onNewMessage.handlers).toHaveLength(0)
    expect(oldClient.onEditMessage.handlers).toHaveLength(0)
    expect(oldClient.onDeleteMessage.handlers).toHaveLength(0)
    expect(oldClient.destroy).toHaveBeenCalledTimes(1)
    expect(lifecycle).toEqual(['start:0', 'destroy:0', 'start:1'])

    // The new client has one set of handlers and a running updates loop
    expect(newClient.onNewMessage.handlers).toHaveLength(1)
    expect(newClient.onEditMessage.handlers).toHaveLength(1)
    expect(newClient.onDeleteMessage.handlers).toHaveLength(1)
    expect(newClient.startUpdatesLoop).toHaveBeenCalledTimes(1)
    expect(newClient.destroy).not.toHaveBeenCalled()

    // A live message on the new client reaches the cache
    newClient.onNewMessage.emit(
      asMessage({
        id: 7,
        chat: { id: 2000, type: 'user' },
        sender: { id: 2000 },
        text: 'After reconnect',
        date: new Date('2024-01-02T00:00:00Z'),
        isOutgoing: false,
      }),
    )
    const cached = createMessagesCache(testCacheDb).get(2000, 7)
    expect(cached?.text).toBe('After reconnect')

    // The sync worker was rebuilt on the new client
    const worker = ctx.runtime.accounts.get(1)?.worker
    expect(worker).not.toBe(oldWorker)
    expect(worker?.client).toBe(newClient as unknown as TelegramClient)

    // Shutdown closes the new client and leaves the old one alone
    const { disconnectAllAccounts } = await import('../daemon/daemon-accounts')
    await disconnectAllAccounts(ctx)
    expect(oldClient.destroy).toHaveBeenCalledTimes(1)
    expect(newClient.destroy).toHaveBeenCalledTimes(1)
    expect(newClient.onNewMessage.handlers).toHaveLength(0)
  })

  it('attemptReconnect cleans up the new client when updates fail to start', async () => {
    const accountsDb = createAccountsDb([
      { id: 1, phone: '+15550000001', user_id: 555 },
    ])
    const ctx = createContext(accountsDb)

    const { attemptReconnect } = await import('../daemon/daemon-accounts')

    updatesLoopError = new Error('updates unavailable')

    const accountState: AccountConnectionState = {
      accountId: 1,
      phone: '+15550000001',
      name: null,
      status: 'error',
      reconnectAttempts: 0,
    }

    expect(await attemptReconnect(ctx, accountState)).toBe(false)

    const client = createdClients[0]!
    expect(client.onNewMessage.handlers).toHaveLength(0)
    expect(client.destroy).toHaveBeenCalledTimes(1)
    expect(accountState.client).toBeUndefined()
    expect(accountState.eventHandlers).toBeUndefined()
    expect(accountState.status).toBe('error')
    expect(accountState.lastError).toBe('updates unavailable')
    expect(accountState.reconnectAttempts).toBe(1)
    expect(accountState.nextReconnectAt).toBeDefined()
  })

  describe('with two accounts', () => {
    let otherDb: Database

    beforeEach(() => {
      otherDb = createAccountCacheDb()
    })

    afterEach(() => {
      otherDb.close()
    })

    async function wireBoth() {
      const accountsDb = createAccountsDb([
        { id: 1, phone: '+15550000001', user_id: 101 },
        { id: 2, phone: '+15550000002', user_id: 202 },
      ])
      const ctx = createBareContext(accountsDb)
      addAccountRuntime(ctx, 1, testCacheDb)
      addAccountRuntime(ctx, 2, otherDb)
      const { setupEventHandlers } = await import('../daemon/daemon-accounts')
      const states = [1, 2].map((accountId) => {
        const state: AccountConnectionState = {
          accountId,
          phone: `+1555000000${accountId}`,
          name: null,
          status: 'connected',
          client: createClient(),
        }
        setupEventHandlers(ctx, state)
        return state
      })
      return { ctx, first: states[0]!, second: states[1]! }
    }

    it("caches a live message only in the receiving account's cache", async () => {
      const { ctx, second } = await wireBoth()

      second.eventHandlers?.onNewMessage(
        asMessage({
          id: 7,
          chat: { id: 4242, type: 'user' },
          sender: { id: 4242 },
          text: 'lunch at one',
          date: new Date('2026-01-02T12:00:00Z'),
          isOutgoing: false,
        }),
      )
      await Bun.sleep(0)

      expect(createMessagesCache(otherDb).get(4242, 7)?.text).toBe(
        'lunch at one',
      )
      expect(createMessagesCache(testCacheDb).get(4242, 7)).toBeNull()
      expect(ctx.runtime.accounts.get(2)?.messagesSynced).toBe(1)
      expect(ctx.runtime.accounts.get(1)?.messagesSynced).toBe(0)
    })

    it("leaves the other account's message with the same ID when a delete has no chat", async () => {
      const { first } = await wireBoth()
      for (const [db, text] of [
        [testCacheDb, 'lunch at noon'],
        [otherDb, 'lunch at one'],
      ] as const) {
        createMessagesCache(db).upsert({
          chat_id: 4242,
          message_id: 7,
          text,
          message_type: 'text',
          date: 1_760_000_000,
          raw_json: '{}',
        })
      }

      first.eventHandlers?.onDeleteMessage(
        asDeleteUpdate({ channelId: null, messageIds: [7] }),
      )
      await Bun.sleep(0)

      expect(createMessagesCache(testCacheDb).get(4242, 7)?.is_deleted).toBe(1)
      expect(createMessagesCache(otherDb).get(4242, 7)?.is_deleted).toBe(0)
    })
  })
})
