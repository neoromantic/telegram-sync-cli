/**
 * History progress for tg status (#126): messages cached against Telegram's
 * counts, and a time left from the measured pace. Made-up data only.
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createChatSyncStateService } from '../db/chat-sync-state'
import {
  HISTORY_PACE_WINDOW_MS,
  readHistoryProgress,
} from '../db/history-progress'
import { createMessagesCache } from '../db/messages-cache'
import { createTestCacheDatabase } from '../db/schema'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'

const NOW = 1_760_000_000_000
const MINUTE = 60_000

let db: Database

beforeEach(() => {
  db = createTestCacheDatabase().db
  initSyncSchema(db)
})

afterEach(() => {
  db.close()
})

function seedChat(
  chatId: number,
  options: {
    total: number | null
    cached: number
    complete?: boolean
    enabled?: boolean
  },
) {
  const state = createChatSyncStateService(db)
  state.upsert({
    chat_id: chatId,
    chat_type: chatId < 0 ? 'group' : 'private',
    sync_priority: SyncPriority.High,
    sync_enabled: options.enabled ?? true,
  })
  if (options.total !== null) state.setTotalMessages(chatId, options.total)
  if (options.complete) state.markHistoryComplete(chatId)
  createMessagesCache(db).upsertBatch(
    Array.from({ length: options.cached }, (_, i) => ({
      chat_id: chatId,
      message_id: i + 1,
      text: `made-up note ${i + 1}`,
      message_type: 'text',
      date: 1_700_000_000 + i,
      raw_json: '{}',
    })),
  )
}

/** A history page the daemon finished at `completedAt` */
function seedPage(
  completedAt: number,
  messages: number,
  jobType = SyncJobType.BackwardHistory,
) {
  db.run(
    `INSERT INTO sync_jobs (chat_id, job_type, status, messages_fetched, completed_at)
     VALUES (101, ?, 'completed', ?, ?)`,
    [jobType, messages, completedAt],
  )
}

describe('readHistoryProgress', () => {
  it('counts a bot that had its newest page as done, at what is cached (#131)', () => {
    seedChat(201, { total: 500, cached: 3 })
    seedChat(202, { total: 40, cached: 0 })
    const state = createChatSyncStateService(db)
    for (const chatId of [201, 202]) {
      state.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        sync_policy: 'bot',
      })
    }
    state.recordFirstPage(201, {
      forward_cursor: 500,
      backward_cursor: 401,
      history_complete: false,
      new_messages: 3,
    })

    // 202 still waits for its first page
    expect(readHistoryProgress(db, { now: NOW })).toMatchObject({
      chats_pending: 1,
      messages_cached: 3,
      messages_known: 43,
      messages_left: 40,
    })
  })

  it('sums messages cached of the counts, for the chats with sync on', () => {
    seedChat(101, { total: 10, cached: 4 })
    seedChat(102, { total: 5, cached: 5, complete: true })
    // Deleted on the server after it was cached: counted once
    seedChat(-4242, { total: 3, cached: 6, complete: true })
    seedChat(103, { total: null, cached: 2 })
    // Complete without a count: an older version synced it
    seedChat(105, { total: null, cached: 7, complete: true })
    seedChat(104, { total: 50, cached: 0, enabled: false })

    expect(readHistoryProgress(db, { now: NOW })).toEqual({
      chats_pending: 2,
      chats_without_count: 1,
      messages_cached: 19,
      messages_known: 25,
      messages_left: 6,
      messages_per_minute: null,
      eta_seconds: null,
      largest_pending: [
        {
          chat_id: 101,
          chat_type: 'private',
          messages_cached: 4,
          messages_known: 10,
          messages_left: 6,
        },
      ],
    })
  })

  it('lists the five pending chats with the most left', () => {
    for (let i = 1; i <= 7; i++) seedChat(200 + i, { total: 10 * i, cached: i })

    const { largest_pending } = readHistoryProgress(db, { now: NOW })

    expect(largest_pending.map((chat) => chat.chat_id)).toEqual([
      207, 206, 205, 204, 203,
    ])
  })

  it('measures the pace of the last history pages and the time left at it', () => {
    seedChat(101, { total: 2100, cached: 100 })
    seedPage(NOW - 10 * MINUTE, 100)
    seedPage(NOW - 6 * MINUTE, 100)
    seedPage(NOW - 2 * MINUTE, 100, SyncJobType.InitialLoad)
    // Not history pages, or too old
    seedPage(NOW - MINUTE, 500, SyncJobType.ForwardCatchup)
    seedPage(NOW - HISTORY_PACE_WINDOW_MS - 1, 900)

    const progress = readHistoryProgress(db, { now: NOW })

    // 200 messages after the first page, in the 10 minutes since it
    expect(progress.messages_per_minute).toBe(20)
    expect(progress.eta_seconds).toBe(2000 * 3)
  })

  it('gives no pace or time left without two recent pages', () => {
    seedChat(101, { total: 2100, cached: 100 })
    seedPage(NOW - 2 * MINUTE, 100)

    const progress = readHistoryProgress(db, { now: NOW })

    expect(progress.messages_per_minute).toBeNull()
    expect(progress.eta_seconds).toBeNull()
  })

  it('gives no time left when nothing is left', () => {
    seedChat(101, { total: 100, cached: 100, complete: true })
    seedPage(NOW - 4 * MINUTE, 50)
    seedPage(NOW - 2 * MINUTE, 50)

    const progress = readHistoryProgress(db, { now: NOW })

    expect(progress.messages_per_minute).toBe(13)
    expect(progress.eta_seconds).toBeNull()
  })
})
