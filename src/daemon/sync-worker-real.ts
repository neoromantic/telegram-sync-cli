/**
 * Real mtcute client integration for sync workers
 */

import type { SyncJobRow } from "../db/sync-schema";
import { canMakeApiCall } from "./sync-worker-real-context";
import { processJobReal } from "./sync-worker-real-jobs";
import {
  DEFAULT_SYNC_WORKER_CONFIG,
  type RealSyncWorkerContext,
  type RealSyncWorkerDeps,
  type SyncWorkerConfig,
} from "./sync-worker-real-types";

export type { RealJobResult } from "./sync-worker-real-types";

/**
 * Create a sync worker that uses the real mtcute TelegramClient
 */
export function createRealSyncWorker(deps: RealSyncWorkerDeps) {
  const config: SyncWorkerConfig = {
    ...DEFAULT_SYNC_WORKER_CONFIG,
    ...deps.config,
  };
  const ctx: RealSyncWorkerContext = {
    client: deps.client,
    messagesCache: deps.messagesCache,
    historyRanges: deps.historyRanges,
    chatSyncState: deps.chatSyncState,
    jobsService: deps.jobsService,
    rateLimits: deps.rateLimits,
    chatsCache: deps.chatsCache,
    usersCache: deps.usersCache,
    senderLookups: deps.senderLookups,
    config,
    signal: deps.signal,
  };

  return {
    /** The client this worker calls; a reconnect replaces the worker */
    client: ctx.client,
    canMakeApiCall: () => canMakeApiCall(ctx),
    processJobReal: (job: SyncJobRow) => processJobReal(ctx, job),
  };
}

export type RealSyncWorker = ReturnType<typeof createRealSyncWorker>;
