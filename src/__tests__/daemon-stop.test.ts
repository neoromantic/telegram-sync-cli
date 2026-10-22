/**
 * The daemon's start and stop with fake clients (#64): a stop while a
 * request of the startup dialog pass or of a sync job waits out a FLOOD_WAIT
 * ends that wait at once, so the daemon stops well inside `tg daemon stop`'s
 * 10 s timeout. The real dialog pass, scheduler, job loop and shutdown run.
 */
import type { Database } from 'bun:sqlite'
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RpcCallOptions, TelegramClient } from '@mtcute/bun'

import type { DaemonContext } from '../daemon/daemon-context'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createDaemonStatusService } from '../db/daemon-status'
import { createSyncJobsService } from '../db/sync-jobs'
import { SyncJobType, SyncPriority } from '../db/sync-schema'
import { createAccountCacheDb } from './helpers/daemon-runtime'
import {
  createFakeAccountsDb,
  mockDbModule,
  testAccount,
} from './helpers/db-mock'
import { type FakeDialogInput, fakeDialogClient } from './helpers/fake-dialogs'
import { waitLikeFloodWait } from './helpers/flood-wait'

const accounts = () => createFakeAccountsDb([testAccount({ id: 1 })])

const caches = new Map<number, Database>()

mock.module('../db', () =>
  mockDbModule({
    cacheFor: (accountId) => {
      const cache = caches.get(accountId)
      if (!cache) throw new Error(`No cache for account ${accountId}`)
      return cache
    },
    accountsDb: accounts(),
  }),
)

/** The client each account connects with */
const clients = new Map<number, TelegramClient>()
mock.module('../daemon/daemon-accounts', () => ({
  connectAccount: async (
    ctx: DaemonContext,
    accountId: number,
    phone: string,
    name: string | null,
  ) => {
    const client = clients.get(accountId)
    ctx.state.accounts.set(accountId, {
      accountId,
      phone,
      name,
      status: client ? 'connected' : 'error',
      client,
    })
    return client !== undefined
  },
  disconnectAllAccounts: async () => {},
  setupSignalHandlers: () => {},
  attemptReconnect: async () => {},
  scheduleReconnect: () => {},
}))

const { createDaemon } = await import('../daemon/daemon')
const { DaemonExitCode } = await import('../daemon/types')

const tempDir = join(process.cwd(), '.tmp', `daemon-stop-${process.pid}`)
const pidPath = join(tempDir, 'daemon.pid')

const CHAT = 1001

/**
 * A fake account client: the dialog pass lists `dialogs` (with the pass's
 * options), and `call` answers the sync jobs' requests
 */
function fakeClient(
  dialogs: FakeDialogInput[],
  options: Parameters<typeof fakeDialogClient>[1],
  call: (request: unknown, params?: RpcCallOptions) => Promise<unknown>,
) {
  const pass = fakeDialogClient(dialogs, options)
  const callMock = mock(call)
  // withParams copies the client, so its copies get the call too
  Object.assign(pass.client, { call: callMock })
  return { client: pass.client, pass, call: callMock }
}

let log: ReturnType<typeof spyOn>
let warn: ReturnType<typeof spyOn>
let error: ReturnType<typeof spyOn>

const output = () =>
  log.mock.calls.map((call: unknown[]) => String(call[0])).join('\n')

beforeEach(() => {
  mkdirSync(tempDir, { recursive: true })
  caches.set(1, createAccountCacheDb())
  log = spyOn(console, 'log').mockImplementation(() => {})
  warn = spyOn(console, 'warn').mockImplementation(() => {})
  error = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  log.mockRestore()
  warn.mockRestore()
  error.mockRestore()
  for (const cache of caches.values()) cache.close()
  caches.clear()
  clients.clear()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('daemon stop during a FLOOD_WAIT', () => {
  it('ends the startup dialog pass and exits at once', async () => {
    const daemon = createDaemon({ pidPath, verbosity: 'verbose' }, accounts())
    let stoppedAt = 0
    const fake = fakeClient(
      [{ kind: 'user', id: CHAT, topMessage: 10 }],
      {
        // The page after the first dialog waits out a FLOOD_WAIT
        waitAfter: 1,
        onWait: () => {
          stoppedAt = performance.now()
          daemon.stop()
        },
      },
      async () => {
        throw new Error('No sync job runs after the stop')
      },
    )
    clients.set(1, fake.client)

    const exitCode = await daemon.start()
    const elapsed = performance.now() - stoppedAt

    expect(exitCode).toBe(DaemonExitCode.Success)
    expect(stoppedAt).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1000)
    expect(fake.pass.params).toHaveLength(1)
    expect(fake.call).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(output()).toContain(
      '[Account 1] Dialog pass stopped after 1 dialogs: the daemon is stopping',
    )
    expect(output()).not.toContain('Dialog page failed during the stop')
    expect(createDaemonStatusService(caches.get(1)!).getAll()).toMatchObject({
      daemon_status: 'stopped',
    })
  })

  it('leaves the sync job pending as it was and exits at once', async () => {
    const cache = caches.get(1)!
    createChatSyncStateService(cache).upsert({
      chat_id: CHAT,
      chat_type: 'private',
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    const jobs = createSyncJobsService(cache)
    const created = jobs.create({
      chat_id: CHAT,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.High,
    })
    // Two earlier tries failed; the job is due now
    cache.run(
      `UPDATE sync_jobs SET attempts = 2, error_message = 'connection reset',
         next_run_at = 0 WHERE id = ?`,
      [created.id],
    )
    const daemon = createDaemon({ pidPath, verbosity: 'verbose' }, accounts())
    let stoppedAt = 0
    const fake = fakeClient(
      [{ kind: 'user', id: CHAT, topMessage: 10 }],
      {},
      (_request, params) =>
        waitLikeFloodWait(params, {
          onWait: () => {
            stoppedAt = performance.now()
            daemon.stop()
          },
        }),
    )
    clients.set(1, fake.client)

    const exitCode = await daemon.start()
    const elapsed = performance.now() - stoppedAt

    expect(exitCode).toBe(DaemonExitCode.Success)
    expect(stoppedAt).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(1000)
    expect(fake.call).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(output()).toContain(
      `[Account 1] Job ${created.id} left pending: the daemon is stopping`,
    )
    expect(jobs.getById(created.id)).toMatchObject({
      status: 'pending',
      attempts: 2,
      error_message: 'connection reset',
      next_run_at: 0,
      started_at: null,
    })
    expect(jobs.countJobs().running).toBe(0)
    expect(createDaemonStatusService(cache).getAll()).toMatchObject({
      daemon_status: 'stopped',
    })
  })
})
