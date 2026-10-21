import type { TelegramClient } from '@mtcute/bun'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { ChatsCache } from '../db/chats-cache'
import type { HistoryRanges } from '../db/history-ranges'
import type { MessagesCache } from '../db/messages-cache'
import type { RateLimitsService } from '../db/rate-limits'
import type { SyncJobsService } from '../db/sync-jobs'
import type { JobResult, SyncWorkerConfig } from './sync-worker-core'

export interface RealSyncWorkerDeps {
  client: TelegramClient
  messagesCache: MessagesCache
  historyRanges: HistoryRanges
  chatSyncState: ChatSyncStateService
  jobsService: SyncJobsService
  rateLimits: RateLimitsService
  chatsCache: ChatsCache
  config?: Partial<SyncWorkerConfig>
}

export interface RealJobResult extends JobResult {
  hasMore?: boolean
  newCursor?: number
  historyComplete?: boolean
}

export interface RealSyncWorkerContext {
  client: TelegramClient
  messagesCache: MessagesCache
  historyRanges: HistoryRanges
  chatSyncState: ChatSyncStateService
  jobsService: SyncJobsService
  rateLimits: RateLimitsService
  chatsCache: ChatsCache
  config: SyncWorkerConfig
}
