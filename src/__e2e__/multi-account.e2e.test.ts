/**
 * E2E: two accounts, each with its own cache (#17). Both caches hold a
 * message with ID 7 and different text; every cache command reads only the
 * account that --account selects, or the active one. Made-up data only.
 */
import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { createDaemonStatusService } from '../db/daemon-status'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { type SyncChatType, SyncJobType, SyncPriority } from '../db/sync-schema'
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

function seedUser(
  db: Database,
  id: number,
  first: string,
  last: string,
  options: { contact: boolean } = { contact: true },
) {
  createUsersCache(db).upsert({
    user_id: String(id),
    first_name: first,
    last_name: last,
    is_contact: options.contact ? 1 : 0,
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

/**
 * Account 1's cache: the account's own user, Alice, their chat, "lunch at
 * noon" and a failed job
 */
function seedAlpha(db: Database) {
  seedUser(db, ALPHA.user_id, 'Alpha', 'Test', { contact: false })
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

/** Account 2's cache: the account's own user, Bob, Book Club and "lunch at one" */
function seedBeta(db: Database) {
  seedUser(db, BETA.user_id, 'Beta', 'Test', { contact: false })
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

/**
 * A lookup that the other account's cache can't answer: its data, or null
 * when it fails (a cache miss goes to Telegram, and there are no
 * credentials)
 */
async function lookup(env: TestEnvironment, args: string[]) {
  const result = await runCli(args, cliOptions(env))
  if (result.exitCode !== 0) return null
  return (JSON.parse(result.stdout) as { data: Record<string, unknown> }).data
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
  // Account 2's chat and contact, by ID: only its cache has them
  const club2 = await lookup(env, [
    'chats',
    'get',
    '--id',
    String(BOOK_CLUB_ID),
    ...selector,
  ])
  const bob = await lookup(env, [
    'contacts',
    'get',
    '--id',
    String(BOB_ID),
    ...selector,
  ])
  const bobSearch = await lookup(env, [
    'contacts',
    'search',
    '--query',
    'Bob',
    ...selector,
  ])
  const bobUser = await lookup(env, ['user', String(BOB_ID), ...selector])
  const me = await run(env, ['me', ...selector])

  type Items = Array<Record<string, unknown>>
  type Person = { firstName?: string }
  return {
    chats: (chats.items as Items).map((chat) => chat.title),
    chatSearch: [
      ...(club.results as Items).map((chat) => chat.title),
      ...(alice.results as Items).map((chat) => chat.title),
    ],
    contacts: (contacts.items as Items).map((contact) => contact.firstName),
    messageSearch: (search.results as Items).map((hit) => hit.text),
    sql: sql.rows,
    chatGet: club2?.title ?? null,
    contactGet: bob?.firstName ?? null,
    contactSearch:
      (bobSearch?.results as Items | undefined)?.map((c) => c.firstName) ??
      null,
    user: (bobUser?.user as Person | undefined)?.firstName ?? null,
    me: (me.user as Person).firstName,
  }
}

const ALPHA_VIEW = {
  chats: ['Alice Able'],
  chatSearch: ['Alice Able'],
  contacts: ['Alice'],
  messageSearch: ['lunch at noon'],
  sql: [{ chat_id: ALICE_ID, message_id: MESSAGE_ID, text: 'lunch at noon' }],
  chatGet: null,
  contactGet: null,
  contactSearch: null,
  user: null,
  me: 'Alpha',
}

const BETA_VIEW = {
  chats: ['Book Club'],
  chatSearch: ['Book Club'],
  contacts: ['Bob'],
  messageSearch: ['lunch at one'],
  sql: [
    { chat_id: BOOK_CLUB_ID, message_id: MESSAGE_ID, text: 'lunch at one' },
  ],
  chatGet: 'Book Club',
  contactGet: 'Bob',
  contactSearch: ['Bob'],
  user: 'Bob',
  me: 'Beta',
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

function configPath(env: TestEnvironment) {
  return join(env.dataDir, 'config.json')
}

function writeConfig(env: TestEnvironment, text: string) {
  writeFileSync(configPath(env), text)
}

function readConfig(env: TestEnvironment) {
  return readFileSync(configPath(env), 'utf8')
}

async function chatTitles(env: TestEnvironment) {
  const data = await run(env, ['chats', 'list'])
  return (data.items as Array<{ title: string }>).map((chat) => chat.title)
}

/**
 * The active accounts in data.db, read without the CLI: every CLI start
 * applies activeAccount from config.json first and would hide what an
 * earlier command wrote
 */
function activeIds(env: TestEnvironment) {
  const db = new Database(join(env.dataDir, 'data.db'), { readonly: true })
  try {
    return db.query('SELECT id FROM accounts WHERE is_active = 1').all()
  } finally {
    db.close()
  }
}

/**
 * Every start applies activeAccount from config.json, so a switch has to
 * last across later commands with and without the key (#61). Account 1 is
 * active in data.db at the start of each test.
 */
describe('E2E: switching accounts', () => {
  const isRoot = process.getuid?.() === 0

  it('keeps the switch without activeAccount and creates no config.json', async () => {
    const env = createTwoAccounts('multi-account-switch')
    try {
      await run(env, ['accounts', 'switch', '--id', '2'])

      expect(await chatTitles(env)).toEqual(['Book Club'])
      expect(await snapshot(env, [])).toEqual(BETA_VIEW)
      expect(await messageText(env, BOOK_CLUB_ID, [])).toBe('lunch at one')
      expect(existsSync(configPath(env))).toBe(false)
    } finally {
      expectNoRootCache(env)
      env.cleanup()
    }
  }, 30_000)

  it('writes the new account to activeAccount and keeps the other keys', async () => {
    const env = createTwoAccounts('multi-account-switch-config')
    try {
      writeConfig(
        env,
        JSON.stringify({
          activeAccount: 1,
          cache: { staleness: { peers: '3d' } },
          note: 'kept',
        }),
      )

      await run(env, ['accounts', 'switch', '--id', '2'])

      expect(await chatTitles(env)).toEqual(['Book Club'])
      expect(await snapshot(env, [])).toEqual(BETA_VIEW)
      expect(await messageText(env, BOOK_CLUB_ID, [])).toBe('lunch at one')
      expect(JSON.parse(readConfig(env))).toEqual({
        activeAccount: 2,
        cache: { staleness: { peers: '3d' } },
        note: 'kept',
      })
      const value = await run(env, ['config', 'get', 'activeAccount'])
      expect(value.value).toBe(2)
    } finally {
      expectNoRootCache(env)
      env.cleanup()
    }
  }, 30_000)

  it('leaves a config.json without activeAccount byte for byte', async () => {
    const env = createTwoAccounts('multi-account-switch-no-key')
    const text = '{"cache":{"staleness":{"peers":"3d"}}}'
    try {
      writeConfig(env, text)

      await run(env, ['accounts', 'switch', '--id', '2'])

      expect(await chatTitles(env)).toEqual(['Book Club'])
      expect(await messageText(env, BOOK_CLUB_ID, [])).toBe('lunch at one')
      expect(readConfig(env)).toBe(text)
    } finally {
      expectNoRootCache(env)
      env.cleanup()
    }
  })

  it('leaves config.json alone when activeAccount already names the account', async () => {
    const env = createTwoAccounts('multi-account-switch-same')
    const text = '{"activeAccount":2}'
    try {
      writeConfig(env, text)

      await run(env, ['accounts', 'switch', '--id', '2'])

      expect(await chatTitles(env)).toEqual(['Book Club'])
      expect(readConfig(env)).toBe(text)
    } finally {
      expectNoRootCache(env)
      env.cleanup()
    }
  })

  it('applies tg config set activeAccount from the next command', async () => {
    const env = createTwoAccounts('multi-account-switch-config-set')
    try {
      writeConfig(env, JSON.stringify({ activeAccount: 1 }))

      await run(env, ['accounts', 'switch', '--id', '2'])
      await run(env, ['config', 'set', 'activeAccount', '1'])

      expect(await chatTitles(env)).toEqual(['Alice Able'])
    } finally {
      expectNoRootCache(env)
      env.cleanup()
    }
  })

  it('applies activeAccount under -q too', async () => {
    const env = createTwoAccounts('multi-account-switch-quiet')
    try {
      writeConfig(env, JSON.stringify({ activeAccount: 2 }))

      const result = await runCli(['-q', 'chats', 'list'], cliOptions(env))

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe('')
      expect(activeIds(env)).toEqual([{ id: 2 }])
    } finally {
      expectNoRootCache(env)
      env.cleanup()
    }
  })

  it.skipIf(isRoot)(
    'changes nothing when config.json is read-only',
    async () => {
      const env = createTwoAccounts('multi-account-switch-read-only')
      const text = JSON.stringify({ activeAccount: 1 })
      try {
        writeConfig(env, text)
        chmodSync(configPath(env), 0o444)

        const result = await failure(env, ['accounts', 'switch', '--id', '2'])

        expect(result.exitCode).toBe(1)
        expect(result.error.code).toBe('GENERAL_ERROR')
        expect(result.error.details).toEqual(
          expect.objectContaining({ path: configPath(env) }),
        )
        // Before any other command: its start would apply activeAccount: 1
        expect(activeIds(env)).toEqual([{ id: 1 }])
        expect(await chatTitles(env)).toEqual(['Alice Able'])
        expect(readConfig(env)).toBe(text)
      } finally {
        chmodSync(configPath(env), 0o644)
        expectNoRootCache(env)
        env.cleanup()
      }
    },
  )
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
    // Book Club is in account 2's chats_cache, which --account 2 syncs
    // above; without --account, account 1 is active and doesn't know it
    const result = await failure(env, ['chats', 'sync', String(BOOK_CLUB_ID)])

    expect(result.exitCode).toBe(3)
    expect(result.error).toMatchObject({
      code: 'INVALID_ARGS',
      details: { chat: String(BOOK_CLUB_ID), account_id: 1 },
    })
    expect(stateOf(1, BOOK_CLUB_ID)).toBeNull()
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
        pacing:
          accountId === 1
            ? { mode: 'history', targetCallsPerSecond: 0.75, floodWaits: 1 }
            : { mode: 'calm', targetCallsPerSecond: 1 / 3, floodWaits: 0 },
      })
      return status
    }
    tick(1, 'connected', 3).recordCatchUp({
      at: Date.UTC(2026, 0, 2, 3, 4, 5),
      reason: 'reconnect',
      offlineMs: 20_000,
      chats: 2,
    })
    tick(2, 'reconnecting', 4)
  })

  afterAll(() => {
    expectNoRootCache(env)
    env.cleanup()
  })

  type StatusAccount = {
    id: number
    cache: { status: string }
    connection: {
      status: string
      last_error: string | null
      last_catch_up: Record<string, unknown> | null
    } | null
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
        cache: expect.objectContaining({ status: 'ok' }),
        connection: {
          status: 'connected',
          last_error: null,
          last_catch_up: {
            at: '2026-01-02T03:04:05.000Z',
            reason: 'reconnect',
            offline_ms: 20_000,
            chats: 2,
          },
        },
        sync: {
          pending_jobs: 0,
          running_jobs: 0,
          failed_jobs: 1,
          retrying_jobs: 0,
        },
        progress: expect.objectContaining({
          chats_enabled: 0,
          chats_history_complete: 0,
          chats_history_pending: 0,
          messages_cached: 1,
        }),
        rate_limits: { api_calls_last_minute: 0, active_flood_waits: 0 },
      }),
      expect.objectContaining({
        id: 2,
        connection: {
          status: 'reconnecting',
          last_error: 'connection reset',
          last_catch_up: null,
        },
        sync: expect.objectContaining({ failed_jobs: 0 }),
        progress: expect.objectContaining({ messages_cached: 1 }),
      }),
    ])
  })

  it("shows each account's sync pace from the live daemon, and their sum (#133)", async () => {
    const data = await run(env, ['status'])
    const accounts = (
      data.accounts as {
        accounts: Array<{ progress: { history: { pacing: unknown } } }>
      }
    ).accounts
    const progress = data.progress as { history: { pacing: unknown } }

    expect(accounts.map((account) => account.progress.history.pacing)).toEqual([
      { mode: 'history', target_calls_per_second: 0.75, flood_waits: 1 },
      { mode: 'calm', target_calls_per_second: 0.33, flood_waits: 0 },
    ])
    expect(progress.history.pacing).toEqual({
      mode: 'history',
      target_calls_per_second: 1.08,
      flood_waits: 1,
    })
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
    expect(output).not.toContain('Only account')
  })

  it('says in pretty output which account --account scoped the figures to', async () => {
    const result = await runCliSuccess(
      ['status', '--account', 'work', '--format', 'pretty'],
      cliOptions(env),
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
    const output = result.stdout.replace(/\x1b\[[0-9;]*m/g, '')

    expect(output).toContain(`Only account #2 ${BETA.phone} [work];`)
    // The account's own line still prints under the overall total
    expect(output).toMatch(/Total\s+2/)
    expect(output).toContain(`#2 ${BETA.phone}`)
    expect(output).toMatch(/reconnecting · 0 queued · history 0\/0 · 1 msgs/)
    expect(output).not.toMatch(/connected · 0 queued · 1 failed/)
  })
})

describe('E2E: status totals over two accounts', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTwoAccounts('multi-account-status-totals')
    const now = Date.now()
    // Calls of the last minute, as api_activity logs them
    const calls = (accountId: number, method: string, count: number) => {
      const db = env.openCacheDb(accountId)
      for (let i = 0; i < count; i++) {
        db.run(
          'INSERT INTO api_activity (timestamp, method, success) VALUES (?, ?, 1)',
          [now - 1000 * i, method],
        )
      }
    }
    calls(1, 'messages.getHistory', 2)
    calls(1, 'users.getUsers', 1)
    calls(2, 'messages.getHistory', 3)
    createRateLimitsService(env.openCacheDb(2)).setFloodWait(
      'messages.getHistory',
      600,
    )

    const syncing = (
      accountId: number,
      chatId: number,
      chatType: SyncChatType,
      synced: number,
      complete: boolean,
    ) => {
      const state = createChatSyncStateService(env.openCacheDb(accountId))
      state.upsert({
        chat_id: chatId,
        chat_type: chatType,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      })
      state.incrementSyncedMessages(chatId, synced)
      if (complete) state.markHistoryComplete(chatId)
    }
    syncing(1, ALICE_ID, 'private', 50, false)
    syncing(1, 102, 'private', 30, false)
    syncing(1, 103, 'private', 90, true)
    syncing(2, BOOK_CLUB_ID, 'group', 80, false)
    syncing(2, BOB_ID, 'private', 20, true)
    syncing(2, 203, 'private', 30, false)
  })

  afterAll(() => {
    expectNoRootCache(env)
    env.cleanup()
  })

  type FloodWait = { account_id: number; method: string }
  type SampleChat = { account_id: number; chat_id: number }

  it('sums the calls by method and lists flood waits with their account', async () => {
    const data = await run(env, ['status'])
    const rateLimits = data.rate_limits as {
      api_calls_last_minute: number
      calls_by_method: Record<string, number>
      active_flood_waits: Array<FloodWait & { remaining_seconds: number }>
    }

    expect(rateLimits.api_calls_last_minute).toBe(6)
    expect(rateLimits.calls_by_method).toEqual({
      'messages.getHistory': 5,
      'users.getUsers': 1,
    })
    expect(rateLimits.active_flood_waits).toEqual([
      expect.objectContaining({
        account_id: 2,
        method: 'messages.getHistory',
      }),
    ])
    expect(rateLimits.active_flood_waits[0]!.remaining_seconds).toBeGreaterThan(
      500,
    )
    expect(
      (
        data.accounts as {
          accounts: Array<{ id: number; rate_limits: unknown }>
        }
      ).accounts.map(({ id, rate_limits }) => ({ id, rate_limits })),
    ).toEqual([
      {
        id: 1,
        rate_limits: { api_calls_last_minute: 3, active_flood_waits: 0 },
      },
      {
        id: 2,
        rate_limits: { api_calls_last_minute: 3, active_flood_waits: 1 },
      },
    ])
  })

  it('orders the sample chats across accounts and keeps the overall top 5', async () => {
    const data = await run(env, ['status'])
    const progress = data.progress as {
      chats_enabled: number
      sample_chats: Array<SampleChat & { synced_messages: number }>
    }

    expect(progress.chats_enabled).toBe(6)
    // History still to go first, then by messages synced, then by account
    expect(
      progress.sample_chats.map(({ account_id, chat_id, synced_messages }) => [
        account_id,
        chat_id,
        synced_messages,
      ]),
    ).toEqual([
      [2, BOOK_CLUB_ID, 80],
      [1, ALICE_ID, 50],
      [1, 102, 30],
      [2, 203, 30],
      [1, 103, 90],
    ])
  })

  it('scopes the merged lists to the account --account selects', async () => {
    const data = await run(env, ['status', '--account', '2'])
    const rateLimits = data.rate_limits as {
      calls_by_method: Record<string, number>
      active_flood_waits: FloodWait[]
    }
    const progress = data.progress as { sample_chats: SampleChat[] }

    expect(rateLimits.calls_by_method).toEqual({ 'messages.getHistory': 3 })
    expect(rateLimits.active_flood_waits).toHaveLength(1)
    expect(progress.sample_chats.map((chat) => chat.chat_id)).toEqual([
      BOOK_CLUB_ID,
      203,
      BOB_ID,
    ])
  })

  it('tags flood waits and sample chats with acct:<id> in pretty output', async () => {
    const result = await runCliSuccess(
      ['status', '--format', 'pretty'],
      cliOptions(env),
    )
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
    const output = result.stdout.replace(/\x1b\[[0-9;]*m/g, '')

    expect(output).toMatch(/messages\.getHistory acct:2 → \d+s remaining/)
    expect(output).not.toContain('messages.getHistory acct:1')
    // The overall top 5 lines, in order, each with its account
    expect(output).toMatch(
      /group chat:-4242 acct:2 → 80 msgs → backfill\n.*private chat:101 acct:1 → 50 msgs/,
    )
    expect(output).toMatch(/private chat:103 acct:1 → 90 msgs → complete/)
    // Top Methods sums both accounts' calls
    expect(output).toMatch(/getHistory 5\n/)
  })
})
