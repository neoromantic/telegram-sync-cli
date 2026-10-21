/**
 * E2E: two accounts, each with its own cache (#17). Both caches hold a
 * message with ID 7 and different text; every cache command reads only the
 * account that --account selects, or the active one. Made-up data only.
 */
import type { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createDaemonStatusService } from '../db/daemon-status'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { SyncJobType, SyncPriority } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { VERSION } from '../version'
import {
  type CliResult,
  NO_CREDENTIALS,
  runCli,
  runCliSuccess,
} from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const ALPHA = {
  phone: '+15550000001',
  user_id: 9001,
  name: 'Alpha Test',
  username: 'alpha_test',
}
const BETA = {
  phone: '+15550000002',
  user_id: 9002,
  name: 'Beta Test',
  username: 'beta_test',
  label: 'work',
}

/** Account 1: Alice, a contact with a private chat */
const ALICE_ID = 101
/** Account 2: Bob, a contact, and the basic group Book Club */
const BOB_ID = 202
const BOOK_CLUB_ID = -4242
const MESSAGE_ID = 7

function seedUser(db: Database, id: number, first: string, last: string) {
  createUsersCache(db).upsert({
    user_id: String(id),
    first_name: first,
    last_name: last,
    is_contact: 1,
    access_hash: String(id * 11),
    fetched_at: Date.now(),
    raw_json: '{}',
  })
}

function seedMessage(db: Database, chatId: number, text: string) {
  createMessagesCache(db).upsertBatch([
    {
      chat_id: chatId,
      message_id: MESSAGE_ID,
      text,
      message_type: 'text',
      date: Math.floor(Date.now() / 1000) - 600,
      raw_json: '{}',
    },
  ])
  createHistoryRanges(db).add(chatId, { low: 1, high: MESSAGE_ID })
}

/** Account 1's cache: Alice, their chat, "lunch at noon" and a failed job */
function seedAlpha(db: Database) {
  seedUser(db, ALICE_ID, 'Alice', 'Able')
  createChatsCache(db).upsertMany(
    [fakeDialog({ kind: 'user', id: ALICE_ID, title: 'Alice Able' })].map(
      dialogToCacheInput,
    ),
  )
  seedMessage(db, ALICE_ID, 'lunch at noon')
  db.run(
    `INSERT INTO sync_jobs (chat_id, job_type, priority, status, attempts, error_message, completed_at)
     VALUES (?, ?, ?, 'failed', 1, 'Telegram API error 400: CHANNEL_PRIVATE', ?)`,
    [ALICE_ID, SyncJobType.InitialLoad, SyncPriority.High, Date.now()],
  )
}

/** Account 2's cache: Bob, Book Club and "lunch at one" */
function seedBeta(db: Database) {
  seedUser(db, BOB_ID, 'Bob', 'Baker')
  createChatsCache(db).upsertMany(
    [
      fakeDialog({
        kind: 'group',
        id: -BOOK_CLUB_ID,
        title: 'Book Club',
        membersCount: 5,
      }),
    ].map(dialogToCacheInput),
  )
  seedMessage(db, BOOK_CLUB_ID, 'lunch at one')
}

function createTwoAccounts(
  name: string,
  options: { active: 1 | 2 | null; betaCache?: boolean } = { active: 1 },
): TestEnvironment {
  const env = createTestEnvironment(name)
  env.initDatabase()
  env.seedAccounts([
    { ...ALPHA, is_active: options.active === 1 },
    { ...BETA, is_active: options.active === 2 },
  ])
  seedAlpha(env.openCacheDb(1))
  if (options.betaCache !== false) seedBeta(env.openCacheDb(2))
  return env
}

function cliOptions(env: TestEnvironment) {
  return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } }
}

async function run(env: TestEnvironment, args: string[]) {
  const result = await runCliSuccess(args, cliOptions(env))
  return (result.json as { data: Record<string, unknown> }).data
}

/** What each cache command returns, reduced to what tells the accounts apart */
async function snapshot(env: TestEnvironment, selector: string[]) {
  const chats = await run(env, ['chats', 'list', ...selector])
  const club = await run(env, [
    'chats',
    'search',
    '--query',
    'Book',
    ...selector,
  ])
  const alice = await run(env, [
    'chats',
    'search',
    '--query',
    'Alice',
    ...selector,
  ])
  const contacts = await run(env, ['contacts', 'list', ...selector])
  const search = await run(env, [
    'messages',
    'search',
    '--query',
    'lunch',
    ...selector,
  ])
  const sql = await run(env, [
    'sql',
    'SELECT chat_id, message_id, text FROM messages_cache ORDER BY chat_id',
    ...selector,
  ])

  type Items = Array<Record<string, unknown>>
  return {
    chats: (chats.items as Items).map((chat) => chat.title),
    chatSearch: [
      ...(club.results as Items).map((chat) => chat.title),
      ...(alice.results as Items).map((chat) => chat.title),
    ],
    contacts: (contacts.items as Items).map((contact) => contact.firstName),
    messageSearch: (search.results as Items).map((hit) => hit.text),
    sql: sql.rows,
  }
}

const ALPHA_VIEW = {
  chats: ['Alice Able'],
  chatSearch: ['Alice Able'],
  contacts: ['Alice'],
  messageSearch: ['lunch at noon'],
  sql: [{ chat_id: ALICE_ID, message_id: MESSAGE_ID, text: 'lunch at noon' }],
}

const BETA_VIEW = {
  chats: ['Book Club'],
  chatSearch: ['Book Club'],
  contacts: ['Bob'],
  messageSearch: ['lunch at one'],
  sql: [
    { chat_id: BOOK_CLUB_ID, message_id: MESSAGE_ID, text: 'lunch at one' },
  ],
}

async function messageText(
  env: TestEnvironment,
  chat: number,
  selector: string[],
) {
  const data = await run(env, [
    'messages',
    'get',
    '--chat',
    String(chat),
    '--id',
    String(MESSAGE_ID),
    ...selector,
  ])
  return (data.message as { text: string }).text
}

function expectNoRootCache(env: TestEnvironment) {
  expect(existsSync(join(env.dataDir, 'cache.db'))).toBe(false)
}

async function failure(env: TestEnvironment, args: string[]) {
  const result: CliResult = await runCli(args, cliOptions(env))
  return {
    exitCode: result.exitCode,
    error: (JSON.parse(result.stderr) as { error: Record<string, unknown> })
      .error,
  }
}

describe('E2E: two accounts, each with its own cache', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTwoAccounts('multi-account')
  })

  afterAll(() => {
    expectNoRootCache(env)
    env.cleanup()
  })

  for (const selector of ['2', '@beta_test', 'work']) {
    it(`reads only account 2 with --account ${selector}`, async () => {
      const flag = ['--account', selector]

      expect(await snapshot(env, flag)).toEqual(BETA_VIEW)
      expect(await messageText(env, BOOK_CLUB_ID, flag)).toBe('lunch at one')
    })
  }

  it('reads only the active account without --account', async () => {
    expect(await snapshot(env, [])).toEqual(ALPHA_VIEW)
    expect(await messageText(env, ALICE_ID, [])).toBe('lunch at noon')
  })

  it("doesn't find a chat of the other account", async () => {
    const result = await failure(env, [
      'messages',
      'get',
      '--chat',
      String(BOOK_CLUB_ID),
      '--id',
      String(MESSAGE_ID),
    ])

    expect(result.exitCode).not.toBe(0)
    expect(JSON.stringify(result.error)).not.toContain('lunch at one')
  })

  it('reports status totals over both caches, each item with its account', async () => {
    const data = await run(env, ['status'])
    const sync = data.sync as {
      failed_jobs: number
      jobs: Array<{ account_id: number; chat_id: number; status: string }>
    }
    const progress = data.progress as {
      messages_cached: number
      chats_cached: number
    }

    expect(sync.failed_jobs).toBe(1)
    expect(sync.jobs).toEqual([
      expect.objectContaining({
        account_id: 1,
        chat_id: ALICE_ID,
        status: 'failed',
      }),
    ])
    expect(progress.messages_cached).toBe(2)
    expect(progress.chats_cached).toBe(2)
  })

  it('names the account in the pretty retry command', async () => {
    const result = await runCliSuccess(
      ['status', '--format', 'pretty'],
      cliOptions(env),
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
    const output = result.stdout.replace(/\x1b\[[0-9;]*m/g, '')

    expect(output).toContain(`chat:${ALICE_ID} acct:1`)
    expect(output).toContain(`tg chats sync ${ALICE_ID} --auto --account 1`)
  })

  it('rejects an account that does not exist', async () => {
    const result = await failure(env, ['chats', 'list', '--account', '3'])

    expect(result.exitCode).toBe(6)
    expect(result.error.code).toBe('ACCOUNT_NOT_FOUND')
  })
})

describe('E2E: switching accounts', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTwoAccounts('multi-account-switch')
  })

  afterAll(() => {
    expectNoRootCache(env)
    env.cleanup()
  })

  it('reads the account tg accounts switch made active', async () => {
    await run(env, ['accounts', 'switch', '--id', '2'])

    expect(await snapshot(env, [])).toEqual(BETA_VIEW)
    expect(await messageText(env, BOOK_CLUB_ID, [])).toBe('lunch at one')
  })
})

describe('E2E: tg chats sync with two accounts', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTwoAccounts('multi-account-sync')
  })

  afterAll(() => {
    expectNoRootCache(env)
    env.cleanup()
  })

  const stateOf = (accountId: number, chatId: number) =>
    createChatSyncStateService(env.openCacheDb(accountId)).get(chatId)

  it("changes only the selected account's sync state", async () => {
    const data = await run(env, [
      'chats',
      'sync',
      String(BOOK_CLUB_ID),
      '--account',
      '2',
    ])

    expect(data).toMatchObject({ id: BOOK_CLUB_ID, mode: 'on' })
    expect(stateOf(2, BOOK_CLUB_ID)).toMatchObject({ sync_mode: 'on' })
    expect(stateOf(1, BOOK_CLUB_ID)).toBeNull()
  })

  it("rejects a chat that is only in the other account's cache", async () => {
    const result = await failure(env, ['chats', 'sync', String(BOB_ID)])

    expect(result.exitCode).toBe(3)
    expect(result.error).toMatchObject({
      code: 'INVALID_ARGS',
      details: { chat: String(BOB_ID), account_id: 1 },
    })
    expect(stateOf(1, BOB_ID)).toBeNull()
  })
})

describe('E2E: which account a command uses', () => {
  it('asks to log in when there is no account, and creates no cache', async () => {
    const env = createTestEnvironment('multi-account-none')
    env.initDatabase()
    try {
      for (const args of [
        ['chats', 'list'],
        ['sql', 'SELECT 1'],
      ]) {
        const result = await failure(env, args)
        expect(result.exitCode).toBe(2)
        expect(result.error.code).toBe('AUTH_REQUIRED')
      }

      const schema = await runCliSuccess(
        ['sql', 'print-schema', '--table', 'messages_cache'],
        cliOptions(env),
      )
      expect(schema.exitCode).toBe(0)
      expect(
        readdirSync(env.dataDir).filter((name) => !name.startsWith('data.db')),
      ).toEqual([])
    } finally {
      env.cleanup()
    }
  })

  it('uses the only account when none is active', async () => {
    const env = createTestEnvironment('multi-account-only')
    env.initDatabase()
    env.seedAccounts([{ ...BETA, is_active: false }])
    seedBeta(env.openCacheDb(1))
    try {
      expect(await messageText(env, BOOK_CLUB_ID, [])).toBe('lunch at one')
    } finally {
      env.cleanup()
    }
  })

  it('lists the accounts when several exist and none is active', async () => {
    const env = createTwoAccounts('multi-account-no-active', {
      active: null,
      betaCache: false,
    })
    try {
      const result = await failure(env, [
        'messages',
        'search',
        '--query',
        'lunch',
      ])

      expect(result.exitCode).toBe(1)
      expect(result.error).toMatchObject({
        code: 'NO_ACTIVE_ACCOUNT',
        details: {
          accounts: [
            { id: 1, phone: ALPHA.phone, username: 'alpha_test', label: null },
            { id: 2, phone: BETA.phone, username: 'beta_test', label: 'work' },
          ],
        },
      })

      // tg status needs no account, and creates no cache for one without
      const status = await run(env, ['status'])
      expect(status.progress).toMatchObject({ messages_cached: 1 })
      expect(existsSync(env.cachePath(2))).toBe(false)
      expectNoRootCache(env)
    } finally {
      env.cleanup()
    }
  })
})

describe('E2E: status per account', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTwoAccounts('multi-account-status')
    // A live daemon wrote both accounts' rows; this test process stands in
    // for it, so daemon.pid names a live PID
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))
    const tick = (accountId: number, connection: string, synced: number) => {
      const status = createDaemonStatusService(env.openCacheDb(accountId))
      status.setDaemonRunning(process.pid, VERSION)
      status.writeTick({
        connectionStatus: connection,
        lastError: connection === 'connected' ? null : 'connection reset',
        messagesSynced: synced,
        pendingJobs: 0,
        runningJobs: 0,
      })
    }
    tick(1, 'connected', 3)
    tick(2, 'reconnecting', 4)
  })

  afterAll(() => {
    expectNoRootCache(env)
    env.cleanup()
  })

  type StatusAccount = {
    id: number
    cache: { status: string }
    connection: { status: string; last_error: string | null } | null
    sync: Record<string, number>
    progress: Record<string, number>
    rate_limits: Record<string, number>
  }

  it('gives each account its own cache, connection, sync, progress and rate limits', async () => {
    const data = await run(env, ['status'])
    const accounts = (data.accounts as { accounts: StatusAccount[] }).accounts

    expect(data.account_id).toBeNull()
    expect(data.daemon).toMatchObject({
      status: 'running',
      connected_accounts: 1,
      total_accounts: 2,
      messages_synced: 7,
    })
    expect(accounts).toEqual([
      expect.objectContaining({
        id: 1,
        cache: { status: 'ok' },
        connection: { status: 'connected', last_error: null },
        sync: {
          pending_jobs: 0,
          running_jobs: 0,
          failed_jobs: 1,
          retrying_jobs: 0,
        },
        progress: {
          chats_enabled: 0,
          chats_history_complete: 0,
          chats_history_pending: 0,
          messages_cached: 1,
        },
        rate_limits: { api_calls_last_minute: 0, active_flood_waits: 0 },
      }),
      expect.objectContaining({
        id: 2,
        connection: { status: 'reconnecting', last_error: 'connection reset' },
        sync: expect.objectContaining({ failed_jobs: 0 }),
        progress: expect.objectContaining({ messages_cached: 1 }),
      }),
    ])
  })

  it('reports only the account --account selects', async () => {
    const data = await run(env, ['status', '--account', 'work'])
    const sync = data.sync as { failed_jobs: number; jobs: unknown[] }

    expect(data.account_id).toBe(2)
    expect(sync).toMatchObject({ failed_jobs: 0, jobs: [] })
    expect(data.progress).toMatchObject({ messages_cached: 1, chats_cached: 1 })
    expect(
      (data.accounts as { accounts: StatusAccount[] }).accounts.map(
        (account) => account.id,
      ),
    ).toEqual([2])
  })

  it('lists each account in tg daemon status, with totals that are their sums', async () => {
    const data = await run(env, ['daemon', 'status'])

    expect(data).toMatchObject({
      status: 'running',
      connectedAccounts: 1,
      totalAccounts: 2,
      messagesSynced: 7,
      messagesCached: 2,
    })
    expect(data.accounts).toEqual([
      {
        id: 1,
        connection: 'connected',
        lastError: null,
        messagesSynced: 3,
        messagesCached: 1,
        chatsEnabled: 0,
        chatsHistoryComplete: 0,
      },
      {
        id: 2,
        connection: 'reconnecting',
        lastError: 'connection reset',
        messagesSynced: 4,
        messagesCached: 1,
        chatsEnabled: 0,
        chatsHistoryComplete: 0,
      },
    ])
  })

  it('prints a line per account in pretty output', async () => {
    const result = await runCliSuccess(
      ['status', '--format', 'pretty'],
      cliOptions(env),
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
    const output = result.stdout.replace(/\x1b\[[0-9;]*m/g, '')

    expect(output).toMatch(
      /connected · 0 queued · 1 failed · history 0\/0 · 1 msgs/,
    )
    expect(output).toMatch(/reconnecting · 0 queued · history 0\/0 · 1 msgs/)
  })
})
