/**
 * Tests for the sync job retry policy: the backoff and which errors are
 * permanent
 */
import { describe, expect, it } from 'bun:test'
import { tl } from '@mtcute/bun'
import {
  isPermanentSyncError,
  retryDelayMs,
  SYNC_RETRY_CONFIG,
} from '../daemon/sync-retry'

describe('retryDelayMs', () => {
  it('waits 1, 2, 4 and 8 minutes after the first four failures', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([
      60_000, 120_000, 240_000, 480_000,
    ])
  })

  it('never waits more than 8 minutes', () => {
    expect(retryDelayMs(10)).toBe(480_000)
  })

  it('gives up after five attempts', () => {
    expect(SYNC_RETRY_CONFIG.maxAttempts).toBe(5)
  })
})

describe('isPermanentSyncError', () => {
  it('treats 400, 403 and 404 RPC errors as permanent', () => {
    for (const error of [
      new tl.RpcError(400, 'CHANNEL_PRIVATE'),
      new tl.RpcError(400, 'PEER_ID_INVALID'),
      new tl.RpcError(403, 'CHAT_ADMIN_REQUIRED'),
      new tl.RpcError(404, 'NOT_FOUND'),
    ]) {
      expect(isPermanentSyncError(error)).toBe(true)
    }
  })

  it('treats CHANNEL_PRIVATE as permanent with any code', () => {
    expect(isPermanentSyncError(new tl.RpcError(406, 'CHANNEL_PRIVATE'))).toBe(
      true,
    )
  })

  it('treats account errors, server errors and the rest as transient', () => {
    for (const error of [
      new tl.RpcError(401, 'AUTH_KEY_UNREGISTERED'),
      new tl.RpcError(406, 'AUTH_KEY_DUPLICATED'),
      new tl.RpcError(420, 'FLOOD_WAIT_X'),
      new tl.RpcError(500, 'INTERNAL'),
      new tl.RpcError(-503, 'Timeout'),
      new Error('connection reset'),
      'string error',
      undefined,
    ]) {
      expect(isPermanentSyncError(error)).toBe(false)
    }
  })
})
