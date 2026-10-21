/**
 * E2E tests for tg status: the sync job counts and list, from a seeded
 * cache, without Telegram credentials
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { createChatSyncStateService } from '../db/chat-sync-state'
import { initCacheSchema } from '../db/schema'
import {
  initSyncSchema,
  SyncJobType,
  type SyncMode,
  SyncPriority,
} from '../db/sync-schema'
import { runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const NO_CREDENTIALS = {
  TELEGRAM_API_ID: undefined,
  TELEGRAM_API_HASH: undefined,
}

const HOUR = 60 * 60 * 1000

interface StatusJob {
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
    cacheDb = new Database(join(env.dataDir, 'cache.db'))
    initCacheSchema(cacheDb)
    initSyncSchema(cacheDb)
  })

  afterEach(() => {
    cacheDb.close()
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

    const output = await prettyStatus()

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

  it('shows an empty queue in pretty output', async () => {
    const result = await runCliSuccess(
      ['status', '--format', 'pretty'],
      options(),
    )

    expect(stripAnsi(result.stdout)).toMatch(/Queue\s+Empty/)
  })
})
