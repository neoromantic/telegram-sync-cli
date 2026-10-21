/**
 * Tests for daemon context defaults
 */
import { describe, expect, it } from 'bun:test'
import {
  createDaemonRuntime,
  totalMessagesSynced,
} from '../daemon/daemon-context'
import { createAccountCacheDb } from './helpers/daemon-runtime'

describe('daemon-context', () => {
  it('creates runtime with sane defaults', () => {
    const runtime = createDaemonRuntime()

    expect(runtime.accounts.size).toBe(0)
    expect(runtime.lastJobAccountId).toBeNull()
    expect(runtime.signalHandlersSetup).toBe(false)
    expect(runtime.dialogPassesInFlight.size).toBe(0)
    expect(totalMessagesSynced(runtime)).toBe(0)
  })

  it('sums the messages synced over every account', () => {
    const runtime = createDaemonRuntime()
    for (const [accountId, messagesSynced] of [
      [1, 40],
      [2, 2],
    ] as const) {
      const db = createAccountCacheDb()
      runtime.accounts.set(accountId, {
        accountId,
        db,
        statusService: {} as never,
        scheduler: null,
        worker: null,
        lastJobProcessTime: 0,
        messagesSynced,
      })
    }

    expect(totalMessagesSynced(runtime)).toBe(42)
  })
})
