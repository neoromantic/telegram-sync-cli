/**
 * Real mtcute client integration for sync workers
 */

import type { SyncJobRow } from '../db/sync-schema'
import {
  DEFAULT_SYNC_WORKER_CONFIG,
  type SyncWorkerConfig,
} from './sync-worker-core'
import {
  canMakeApiCall,
  getInputPeer,
  getWaitTime,
} from './sync-worker-real-context'
import { parseRawMessage } from './sync-worker-real-helpers'
import {
  processBackwardHistoryReal,
  processForwardCatchupReal,
  processInitialLoadReal,
  processJobReal,
} from './sync-worker-real-jobs'
import type {
  RealJobResult,
  RealSyncWorkerContext,
  RealSyncWorkerDeps,
} from './sync-worker-real-types'
import { runOnceBase } from './sync-worker-utils'

export {
  buildInputPeer,
  extractFloodWaitSeconds,
  fetchMessagesRaw,
  parseRawMessage,
} from './sync-worker-real-helpers'
export type {
  RealJobResult,
  RealSyncWorkerDeps,
} from './sync-worker-real-types'

async function runOnceReal(
  ctx: RealSyncWorkerContext,
): Promise<RealJobResult | null> {
  return runOnceBase<RealJobResult>({
    canMakeApiCall: () => canMakeApiCall(ctx),
    getWaitTime: () => getWaitTime(ctx),
    getNextJob: () => ctx.jobsService.getNextPending(),
    processJob: (job) => processJobReal(ctx, job),
  })
}

/**
 * Create a sync worker that uses the real mtcute TelegramClient
 */
export function createRealSyncWorker(deps: RealSyncWorkerDeps) {
  const config: SyncWorkerConfig = {
    ...DEFAULT_SYNC_WORKER_CONFIG,
    ...deps.config,
  }
  const ctx: RealSyncWorkerContext = {
    client: deps.client,
    messagesCache: deps.messagesCache,
    chatSyncState: deps.chatSyncState,
    jobsService: deps.jobsService,
    rateLimits: deps.rateLimits,
    chatsCache: deps.chatsCache,
    config,
  }

  return {
    processJobReal: (job: SyncJobRow) => processJobReal(ctx, job),
    processForwardCatchupReal: (job: SyncJobRow) =>
      processForwardCatchupReal(ctx, job),
    processBackwardHistoryReal: (job: SyncJobRow) =>
      processBackwardHistoryReal(ctx, job),
    processInitialLoadReal: (job: SyncJobRow) =>
      processInitialLoadReal(ctx, job),
    runOnceReal: () => runOnceReal(ctx),
    canMakeApiCall: () => canMakeApiCall(ctx),
    getWaitTime: () => getWaitTime(ctx),
    buildInputPeer: (chatId: number) => getInputPeer(ctx, chatId),
    parseRawMessage,
  }
}

export type RealSyncWorker = ReturnType<typeof createRealSyncWorker>
