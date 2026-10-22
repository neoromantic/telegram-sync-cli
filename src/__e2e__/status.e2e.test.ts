/**
 * E2E tests for tg status: the sync job counts and list, from a seeded
 * cache, without Telegram credentials
 */

import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createChatSyncStateService } from '../db/chat-sync-state'
import { createDaemonStatusService } from '../db/daemon-status'
import { SyncJobType, type SyncMode, SyncPriority } from '../db/sync-schema'
import { VERSION } from '../version'
import { runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const NO_CREDENTIALS = {
  TELEGRAM_API_ID: undefined,
  TELEGRAM_API_HASH: undefined,
}

const HOUR = 60 * 60 * 1000

interface StatusJob {
  account_id: number
  id: number
  chat_id: number
  type: string
  status: string
  messages_fetched: number
  attempts: number
  error: string | null
  next_run_at: string | null
  sync_mode: SyncMode | null
}

interface StatusResult {
  success: boolean
  data: {
    sync: {
      pending_jobs: number
      running_jobs: number
      failed_jobs: number
      retrying_jobs: number
      jobs: StatusJob[]
    }
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colors
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

describe('E2E: status', () => {
  let env: TestEnvironment
  let cacheDb: Database

  beforeEach(() => {
    env = createTestEnvironment('status')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000001', is_active: true }])
    cacheDb = env.openCacheDb(1)
  })

  afterEach(() => {
    env.cleanup()
  })

  function options() {
    return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } }
  }

  /** Insert a job row as the daemon leaves it */
  function seedJob(job: {
    chat_id: number
    job_type: SyncJobType
    status: string
    attempts?: number
    next_run_at?: number
    error_message?: string | null
    completed_at?: number | null
  }): number {
    cacheDb.run(
      `INSERT INTO sync_jobs
         (chat_id, job_type, priority, status, attempts, next_run_at, error_message, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.chat_id,
        job.job_type,
        SyncPriority.High,
        job.status,
        job.attempts ?? 0,
        job.next_run_at ?? 0,
        job.error_message ?? null,
        job.completed_at ?? null,
      ],
    )
    return (
      cacheDb.query('SELECT last_insert_rowid() AS id').get() as { id: number }
    ).id
  }

  /** Give a chat sync state with a mode, as tg chats sync leaves it */
  function seedChat(
    chatId: number,
    chatType: 'private' | 'channel',
    mode: SyncMode,
  ) {
    const chatSyncState = createChatSyncStateService(cacheDb)
    chatSyncState.upsert({
      chat_id: chatId,
      chat_type: chatType,
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    chatSyncState.setSyncMode(chatId, mode)
  }

  const modeOf = (chatId: number) =>
    createChatSyncStateService(cacheDb).get(chatId)?.sync_mode

  /** A channel turned on with CHANNEL_PRIVATE, and an auto DM out of attempts */
  function seedFailed() {
    const now = Date.now()
    seedChat(-1001234567890, 'channel', 'on')
    seedChat(1001, 'private', 'auto')
    return [
      seedJob({
        chat_id: -1001234567890,
        job_type: SyncJobType.InitialLoad,
        status: 'failed',
        attempts: 1,
        error_message: 'Telegram API error 400: CHANNEL_PRIVATE',
        completed_at: now - HOUR,
      }),
      seedJob({
        chat_id: 1001,
        job_type: SyncJobType.ForwardCatchup,
        status: 'failed',
        attempts: 5,
        error_message: 'connection reset',
        completed_at: now - 2 * HOUR,
      }),
    ]
  }

  async function status() {
    const result = await runCliSuccess(['status'], options())
    return result.json as StatusResult
  }

  it('counts and lists running, pending, retrying and failed jobs', async () => {
    const nextRunAt = Date.now() + HOUR
    const running = seedJob({
      chat_id: 1002,
      job_type: SyncJobType.BackwardHistory,
      status: 'running',
    })
    const due = seedJob({
      chat_id: 1003,
      job_type: SyncJobType.InitialLoad,
      status: 'pending',
    })
    const retrying = seedJob({
      chat_id: 1004,
      job_type: SyncJobType.BackwardHistory,
      status: 'pending',
      attempts: 2,
      next_run_at: nextRunAt,
      error_message: 'connection reset',
    })
    const [channelFailed, chatFailed] = seedFailed()

    const { data } = await status()

    expect(data.sync).toMatchObject({
      pending_jobs: 2,
      running_jobs: 1,
      failed_jobs: 2,
      retrying_jobs: 1,
    })
    const byId = new Map(data.sync.jobs.map((job) => [job.id, job]))
    expect(byId.get(running!)).toMatchObject({
      status: 'running',
      attempts: 0,
      error: null,
      next_run_at: null,
      sync_mode: null,
    })
    expect(byId.get(due!)).toMatchObject({
      status: 'pending',
      attempts: 0,
      next_run_at: null,
    })
    expect(byId.get(retrying!)).toMatchObject({
      status: 'pending',
      attempts: 2,
      error: 'connection reset',
      next_run_at: new Date(nextRunAt).toISOString(),
    })
    expect(byId.get(channelFailed!)).toEqual({
      account_id: 1,
      id: channelFailed!,
      chat_id: -1001234567890,
      type: SyncJobType.InitialLoad,
      status: 'failed',
      messages_fetched: 0,
      attempts: 1,
      error: 'Telegram API error 400: CHANNEL_PRIVATE',
      next_run_at: null,
      sync_mode: 'on',
    })
    expect(byId.get(chatFailed!)).toMatchObject({
      status: 'failed',
      attempts: 5,
      error: 'connection reset',
      sync_mode: 'auto',
    })
  })

  it('lists only the 5 newest failed jobs, but counts them all', async () => {
    const now = Date.now()
    const failed = [1, 2, 3, 4, 5, 6].map((age) =>
      seedJob({
        chat_id: 2000 + age,
        job_type: SyncJobType.InitialLoad,
        status: 'failed',
        attempts: 1,
        error_message: 'Telegram API error 400: CHANNEL_PRIVATE',
        completed_at: now - age * HOUR,
      }),
    )

    const { data } = await status()

    expect(data.sync.failed_jobs).toBe(6)
    expect(data.sync.jobs.map((job) => job.id)).toEqual(failed.slice(0, 5))
  })

  it('reports no next_run_at for a retry whose backoff has ended', async () => {
    const due = seedJob({
      chat_id: 1005,
      job_type: SyncJobType.BackwardHistory,
      status: 'pending',
      attempts: 1,
      next_run_at: Date.now() - 5000,
      error_message: 'connection reset',
    })

    const { data } = await status()

    expect(data.sync.retrying_jobs).toBe(1)
    expect(data.sync.jobs).toEqual([
      expect.objectContaining({
        id: due,
        status: 'pending',
        attempts: 1,
        next_run_at: null,
      }),
    ])
  })

  it('reports zero jobs for an empty queue', async () => {
    const { data } = await status()

    expect(data.sync).toEqual({
      pending_jobs: 0,
      running_jobs: 0,
      failed_jobs: 0,
      retrying_jobs: 0,
      jobs: [],
    })
  })

  async function prettyStatus() {
    const result = await runCliSuccess(
      ['status', '--format', 'pretty'],
      options(),
    )
    return stripAnsi(result.stdout)
  }

  /** The retry commands the pretty output prints, one per line */
  const retryCommands = (output: string) =>
    [...output.matchAll(/^\s+tg (chats sync .+)$/gm)].map((match) =>
      match[1]!.split(' '),
    )

  it('shows failed jobs and their errors in pretty output', async () => {
    seedFailed()
    // Jobs that haven't failed are listed, but get no retry command
    seedChat(1002, 'private', 'auto')
    seedJob({
      chat_id: 1002,
      job_type: SyncJobType.BackwardHistory,
      status: 'running',
    })
    seedChat(1003, 'private', 'on')
    seedJob({
      chat_id: 1003,
      job_type: SyncJobType.InitialLoad,
      status: 'pending',
    })

    const output = await prettyStatus()

    expect(output).toContain('chat:1002')
    expect(output).toContain('chat:1003')
    expect(output).toMatch(/Failed\s+2 jobs/)
    expect(output).toContain(
      'failed after 1 attempt: Telegram API error 400: CHANNEL_PRIVATE',
    )
    expect(output).toContain('failed after 5 attempts: connection reset')
    expect(output).toContain("retry at the daemon's next refresh")
    expect(retryCommands(output)).toEqual([
      ['chats', 'sync', '-1001234567890'],
      ['chats', 'sync', '1001', '--auto'],
    ])
    expect(output).not.toContain('Empty')
  })

  it('shows retrying and deferred jobs and when they run in pretty output', async () => {
    const now = Date.now()
    seedJob({
      chat_id: 1004,
      job_type: SyncJobType.BackwardHistory,
      status: 'pending',
      attempts: 2,
      next_run_at: now + 30 * 60_000,
      error_message: 'connection reset',
    })
    seedJob({
      chat_id: 1006,
      job_type: SyncJobType.InitialLoad,
      status: 'pending',
      next_run_at: now + 10 * 60_000,
      error_message: 'Rate limited: wait 600s',
    })

    const output = await prettyStatus()

    expect(output).toMatch(/Pending\s+2 jobs/)
    expect(output).toMatch(/Retrying\s+1 jobs/)
    expect(output).toMatch(
      /chat:1004 attempt 2 of 5, next in \d+m \d+s: connection reset/,
    )
    // A FLOOD_WAIT deferral used no attempt, so it shows only when it runs
    expect(output).toMatch(/chat:1006 next in \d+m \d+s$/m)
    expect(output).not.toMatch(/Failed\s+\d+ jobs/)
  })

  it("prints retry commands that keep each chat's mode", async () => {
    seedFailed()
    const commands = retryCommands(await prettyStatus())
    expect(commands).toHaveLength(2)

    for (const command of commands) {
      const result = await runCliSuccess(command, options())
      expect(result.json).toMatchObject({
        success: true,
        data: { changed: false, clearedFailedJobs: 1 },
      })
    }

    expect(modeOf(-1001234567890)).toBe('on')
    expect(modeOf(1001)).toBe('auto')
    const { data } = await status()
    expect(data.sync.failed_jobs).toBe(0)
  })

  it('says when a stopped daemon last wrote its status', async () => {
    const lastUpdate = Date.now() - 2 * HOUR
    // What setDaemonStopped leaves: no daemon_pid, the last tick's time
    cacheDb.run(
      `INSERT INTO daemon_status (key, value) VALUES
         ('daemon_status', 'stopped'),
         ('connection_status', 'disconnected'),
         ('messages_synced', '12'),
         ('last_update', ?)`,
      [String(lastUpdate)],
    )

    const result = await runCliSuccess(['status'], options())
    const daemon = (
      result.json as { data: { daemon: Record<string, unknown> } }
    ).data.daemon

    expect(daemon).toMatchObject({
      status: 'stopped',
      pid: null,
      last_update: new Date(lastUpdate).toISOString(),
      connected_accounts: 0,
      total_accounts: 0,
      messages_synced: 0,
    })
    expect(await prettyStatus()).toMatch(/Last Update\s+2h ago/)
  })

  it('shows an empty queue in pretty output', async () => {
    const result = await runCliSuccess(
      ['status', '--format', 'pretty'],
      options(),
    )

    expect(stripAnsi(result.stdout)).toMatch(/Queue\s+Empty/)
  })
})

describe('E2E: status, daemon version', () => {
  const OTHER = '0.0.1'
  const NEWER = '99.0.0'

  let env: TestEnvironment
  let cacheDb: Database

  beforeEach(() => {
    env = createTestEnvironment('status-daemon-version')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000001', is_active: true }])
    // The daemon writes its rows to each account's own cache
    cacheDb = env.openCacheDb(1)
  })

  afterEach(() => {
    env.cleanup()
  })

  function options() {
    return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } }
  }

  /** The test runner is alive, so tg status sees a running daemon */
  function writePidFile() {
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))
  }

  const daemonStatus = () => createDaemonStatusService(cacheDb)

  /** The rows a daemon that records no version writes at start */
  function seedUnversionedDaemon(pid: number) {
    const service = daemonStatus()
    service.set('daemon_pid', String(pid))
    service.set('daemon_started_at', String(Date.now()))
    service.set('daemon_status', 'running')
  }

  interface DaemonVersionResult {
    success: boolean
    data: {
      daemon: {
        status: string
        pid: number | null
        version: string | null
        version_mismatch: boolean
      }
      cli_version: string
    }
  }

  async function status() {
    const result = await runCliSuccess(['status'], options())
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    return result.json as DaemonVersionResult
  }

  async function prettyStatus() {
    const result = await runCliSuccess(
      ['status', '--format', 'pretty'],
      options(),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe('')
    return stripAnsi(result.stdout)
  }

  const escapeRegex = (text: string) =>
    text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const RESTART_STOP = /^\s+tg daemon stop$/m
  const RESTART_START = /^\s+tg daemon start$/m

  it('reports an older daemon and how to restart it', async () => {
    writePidFile()
    daemonStatus().setDaemonRunning(process.pid, OTHER)

    const { data } = await status()
    expect(data.daemon).toMatchObject({
      status: 'running',
      pid: process.pid,
      version: OTHER,
      version_mismatch: true,
    })
    expect(data.cli_version).toBe(VERSION)

    const output = await prettyStatus()
    expect(output).toMatch(/Version\s+0\.0\.1/)
    expect(output).toContain(`this tg is ${VERSION}`)
    expect(output).toMatch(RESTART_STOP)
    expect(output).toMatch(RESTART_START)
  })

  it('shows the version and no hint for a daemon of this version', async () => {
    writePidFile()
    daemonStatus().setDaemonRunning(process.pid, VERSION)

    const { data } = await status()
    expect(data.daemon.version).toBe(VERSION)
    expect(data.daemon.version_mismatch).toBe(false)
    expect(data.cli_version).toBe(VERSION)

    const output = await prettyStatus()
    expect(output).toMatch(
      new RegExp(`^\\s+Version\\s+${escapeRegex(VERSION)}$`, 'm'),
    )
    expect(output).not.toContain('⚠ The daemon')
    expect(output).not.toContain('tg daemon stop')
  })

  it('counts a running daemon that recorded no version as older', async () => {
    writePidFile()
    seedUnversionedDaemon(process.pid)

    const { data } = await status()
    expect(data.daemon).toMatchObject({
      status: 'running',
      version: null,
      version_mismatch: true,
    })

    const output = await prettyStatus()
    expect(output).toMatch(/Version\s+not recorded/)
    expect(output).toContain('started by an older tg')
    expect(output).toMatch(RESTART_STOP)
    expect(output).toMatch(RESTART_START)
  })

  it('says to use the newer tg rather than restart a newer daemon', async () => {
    writePidFile()
    daemonStatus().setDaemonRunning(process.pid, NEWER)

    const { data } = await status()
    expect(data.daemon.version).toBe(NEWER)
    expect(data.daemon.version_mismatch).toBe(true)

    const output = await prettyStatus()
    expect(output).toMatch(/Version\s+99\.0\.0/)
    expect(output).toContain('newer than this tg')
    expect(output).not.toContain('tg daemon stop')
  })

  /** A stopped daemon reports no version and no hint */
  async function expectNoVersionWhileStopped() {
    const { data } = await status()
    expect(data.daemon).toMatchObject({
      status: 'stopped',
      version: null,
      version_mismatch: false,
    })

    const output = await prettyStatus()
    expect(output).not.toMatch(/^\s+Version\s/m)
    expect(output).not.toContain('⚠ The daemon')
  }

  it('reports no version for a daemon that died without cleanup', async () => {
    daemonStatus().setDaemonRunning(4242, OTHER)

    await expectNoVersionWhileStopped()
  })

  it('reports no version for a daemon that stopped cleanly', async () => {
    // No PID file and no daemon_pid row: both PIDs are null
    daemonStatus().setDaemonRunning(4242, OTHER)
    daemonStatus().setDaemonStopped()

    await expectNoVersionWhileStopped()
  })

  it('reports no version when no daemon has run', async () => {
    await expectNoVersionWhileStopped()
  })

  it('compares nothing while the daemon is still starting', async () => {
    // The PID file is written, but the rows are still the previous daemon's
    writePidFile()
    daemonStatus().setDaemonRunning(process.pid + 1, OTHER)

    const { data } = await status()
    expect(data.daemon).toMatchObject({
      status: 'running',
      pid: process.pid,
      version: null,
      version_mismatch: false,
    })

    const output = await prettyStatus()
    expect(output).not.toMatch(/^\s+Version\s/m)
    expect(output).not.toContain('⚠ The daemon')
  })
})
