import type { TelegramClient } from "@mtcute/bun";
import type { ChatSyncStateService } from "../db/chat-sync-state";
import type { ChatsCache } from "../db/chats-cache";
import type { HistoryRanges } from "../db/history-ranges";
import type { MessagesCache } from "../db/messages-cache";
import type { RateLimitsService } from "../db/rate-limits";
import type { SenderLookups } from "../db/sender-lookups";
import type { SyncJobsService } from "../db/sync-jobs";
import type { UsersCache } from "../db/users-cache";
import type { JobResultLike } from "./sync-worker-utils";

export interface SyncWorkerConfig {
  /** Batch size for fetching messages */
  batchSize: number;
  /** API method name for rate limiting */
  apiMethod: string;
}

export const DEFAULT_SYNC_WORKER_CONFIG: SyncWorkerConfig = {
  batchSize: 100,
  apiMethod: "messages.getHistory",
};

export interface RealSyncWorkerDeps {
  client: TelegramClient;
  messagesCache: MessagesCache;
  historyRanges: HistoryRanges;
  chatSyncState: ChatSyncStateService;
  jobsService: SyncJobsService;
  rateLimits: RateLimitsService;
  chatsCache: ChatsCache;
  /** Where the senders of history pages go */
  usersCache: UsersCache;
  /** Senders missing from users_cache, for fetch_senders jobs (#143) */
  senderLookups: SenderLookups;
  config?: Partial<SyncWorkerConfig>;
  /** The daemon's stop signal: it ends the request a job waits on */
  signal?: AbortSignal;
}

export interface RealJobResult extends JobResultLike {
  hasMore?: boolean;
  newCursor?: number;
  historyComplete?: boolean;
}

export interface RealSyncWorkerContext {
  client: TelegramClient;
  messagesCache: MessagesCache;
  historyRanges: HistoryRanges;
  chatSyncState: ChatSyncStateService;
  jobsService: SyncJobsService;
  rateLimits: RateLimitsService;
  chatsCache: ChatsCache;
  /** Where the senders of history pages go */
  usersCache: UsersCache;
  /** Senders missing from users_cache, for fetch_senders jobs (#143) */
  senderLookups: SenderLookups;
  config: SyncWorkerConfig;
  /** The daemon's stop signal: it ends the request a job waits on */
  signal?: AbortSignal;
}
