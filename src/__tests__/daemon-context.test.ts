/**
 * Tests for daemon context defaults
 */
import { describe, expect, it } from 'bun:test'
import {
  createDaemonRuntime,
  type DaemonContext,
  requestShutdown,
  totalMessagesSynced,
} from '../daemon/daemon-context'
import { isDaemonStopError } from '../daemon/daemon-utils'
import { createSyncPacer } from '../daemon/sync-pacing'
import { createAccountCacheDb } from './helpers/daemon-runtime'

describe('daemon-context', () => {
  it('creates runtime with sane defaults', () => {
    const runtime = createDaemonRuntime()

    expect(runtime.accounts.size).toBe(0)
    expect(runtime.jobsInFlight.size).toBe(0)
    expect(runtime.signalHandlersSetup).toBe(false)
    expect(runtime.dialogPassesInFlight.size).toBe(0)
    expect(runtime.shutdown.signal.aborted).toBe(false)
    expect(totalMessagesSynced(runtime)).toBe(0)
  })

  it('requestShutdown sets the flag and aborts the stop signal once', () => {
    const ctx = {
      state: { running: true, accounts: new Map(), shutdownRequested: false },
      runtime: createDaemonRuntime(),
    } as unknown as DaemonContext
    const { signal } = ctx.runtime.shutdown

    requestShutdown(ctx)

    expect(ctx.state.shutdownRequested).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(isDaemonStopError(signal.reason)).toBe(true)
    expect(signal.reason).toMatchObject({
      name: 'DaemonStopError',
      message: 'The daemon is stopping',
    })

    // A second signal, SIGINT after SIGTERM say, keeps the first reason
    const reason = signal.reason
    requestShutdown(ctx)
    expect(signal.reason).toBe(reason)
    expect(ctx.state.shutdownRequested).toBe(true)
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
        pacer: createSyncPacer(),
        messagesSynced,
      })
    }

    expect(totalMessagesSynced(runtime)).toBe(42)
  })
})
