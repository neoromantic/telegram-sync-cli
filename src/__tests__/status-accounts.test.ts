/**
 * tg status reads each account's cache on its own: a cache that opens but
 * fails a query reports an error for that account only. Made-up data only.
 */
import type { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

import type { createPidFile } from '../daemon'
import { createMessagesCache } from '../db/messages-cache'
import { createAccountCacheDb } from './helpers/daemon-runtime'
import {
  createFakeAccountsDb,
  mockDbModule,
  testAccount,
} from './helpers/db-mock'

const caches = new Map<number, Database>()

mock.module('../db', () =>
  mockDbModule({
    cacheFor: (accountId) => {
      const cache = caches.get(accountId)
      if (!cache) throw new Error(`No cache for account ${accountId}`)
      return cache
    },
    accountsDb: createFakeAccountsDb([
      testAccount({ id: 1 }),
      testAccount({ id: 2, phone: '+15550000002', is_active: 0 }),
    ]),
  }),
)

const { collectStatus, readAccountStatus } = await import('../commands/status')

const noDaemon = {
  read: () => null,
  isRunning: () => false,
} as unknown as ReturnType<typeof createPidFile>

beforeEach(() => {
  for (const accountId of [1, 2]) {
    const cache = createAccountCacheDb()
    createMessagesCache(cache).upsertBatch([
      {
        chat_id: 101,
        message_id: accountId,
        text: `note ${accountId}`,
        message_type: 'text',
        date: 1_760_000_000,
        raw_json: '{}',
      },
    ])
    caches.set(accountId, cache)
  }
  // Account 1's cache opens, but a query fails, as with a corrupt page
  caches.get(1)!.run('DROP TABLE messages_cache')
})

afterEach(() => {
  for (const cache of caches.values()) cache.close()
  caches.clear()
})

describe('tg status with a cache that fails a query', () => {
  it('reports the error with zeroed figures', () => {
    const snapshot = readAccountStatus(1)

    expect(snapshot.cache).toEqual({
      status: 'error',
      error: expect.stringContaining('messages_cache'),
    })
    expect(snapshot.progress.messages_cached).toBe(0)
    expect(snapshot.sync.pending_jobs).toBe(0)
    expect(snapshot.daemon).toBeNull()
  })

  it("still reports the other account's figures", async () => {
    const status = await collectStatus(noDaemon, { dataDir: '/nonexistent' })

    expect(status.accounts.accounts.map((a) => [a.id, a.cache.status])).toEqual(
      [
        [1, 'error'],
        [2, 'ok'],
      ],
    )
    expect(status.accounts.accounts[1]?.progress.messages_cached).toBe(1)
    expect(status.progress.messages_cached).toBe(1)
    expect(status.daemon.status).toBe('stopped')
  })
})
