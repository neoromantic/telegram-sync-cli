/**
 * Sync scheduler for managing background synchronization jobs
 * Implements priority-based job queue with forward catchup and backward history sync
 */
import type { Database } from 'bun:sqlite'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { MessagesCache } from '../db/messages-cache'
import type { SyncJobsService } from '../db/sync-jobs'
import { type SyncJobRow, SyncJobType, SyncPriority } from '../db/sync-schema'

/**
 * Scheduler status
 */
export interface SchedulerStatus {
  /** Number of pending jobs */
  pendingJobs: number
  /** Number of running jobs */
  runningJobs: number
  /** Jobs by type */
  jobsByType: Record<string, number>
  /** Jobs by priority */
  jobsByPriority: Record<number, number>
}

/**
 * Sync scheduler interface
 */
export interface SyncScheduler {
  /** Queue forward catchup job for a chat */
  queueForwardCatchup(chatId: number): void
  /** Queue backward history sync job for a chat */
  queueBackwardHistory(chatId: number): void
  /** Queue initial load job for a chat */
  queueInitialLoad(chatId: number): void
  /** Initialize scheduler with startup jobs */
  initializeForStartup(): Promise<void>
  /** Refresh job queue based on current sync state */
  refreshQueues(): void
  /** Get next job to process (non-atomic, use claimNextJob for concurrent safety) */
  getNextJob(): SyncJobRow | null
  /** Atomically claim and start the next pending job (prevents race conditions) */
  claimNextJob(): SyncJobRow | null
  /** Mark job as running */
  startJob(jobId: number): boolean
  /** Mark job as completed */
  completeJob(jobId: number): boolean
  /** Mark job as failed */
  failJob(jobId: number, errorMessage: string): boolean
  /** Update job progress */
  updateProgress(jobId: number, messagesFetched: number, cursor?: number): void
  /** Get scheduler status */
  getStatus(): SchedulerStatus
  /** Clean up old completed jobs */
  cleanup(maxAgeMs?: number): number
  /** Cancel all pending jobs for a chat */
  cancelJobsForChat(chatId: number): number
  /** Recover jobs that were running when daemon crashed */
  recoverCrashedJobs(): number
}

/**
 * Options for creating sync scheduler
 */
export interface SyncSchedulerOptions {
  db: Database
  jobsService: SyncJobsService
  chatSyncState: ChatSyncStateService
  messagesCache: MessagesCache
}

/**
 * Create sync scheduler
 */
class SyncSchedulerImpl implements SyncScheduler {
  constructor(private readonly options: SyncSchedulerOptions) {}

  private get jobsService() {
    return this.options.jobsService
  }

  private get chatSyncState() {
    return this.options.chatSyncState
  }

  private get messagesCache() {
    return this.options.messagesCache
  }

  queueForwardCatchup(chatId: number): void {
    if (
      this.jobsService.hasActiveJobForChat(chatId, SyncJobType.ForwardCatchup)
    ) {
      return
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.ForwardCatchup,
      priority: SyncPriority.Realtime,
    })
  }

  queueBackwardHistory(chatId: number): void {
    const state = this.chatSyncState.get(chatId)
    if (state?.history_complete) {
      return
    }

    if (
      this.jobsService.hasActiveJobForChat(chatId, SyncJobType.BackwardHistory)
    ) {
      return
    }

    if (state?.backward_cursor === null) {
      const cachedCount = this.messagesCache.countByChatId(chatId)
      if (cachedCount === 0) {
        if (
          !this.jobsService.hasActiveJobForChat(chatId, SyncJobType.InitialLoad)
        ) {
          this.jobsService.create({
            chat_id: chatId,
            job_type: SyncJobType.InitialLoad,
            priority: state?.sync_priority ?? SyncPriority.Medium,
          })
        }
        return
      }
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: SyncPriority.Background,
    })
  }

  queueInitialLoad(chatId: number): void {
    if (this.jobsService.hasActiveJobForChat(chatId, SyncJobType.InitialLoad)) {
      return
    }

    const state = this.chatSyncState.get(chatId)
    const priority = state?.sync_priority ?? SyncPriority.Medium

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.InitialLoad,
      priority,
    })
  }

  async initializeForStartup(): Promise<void> {
    this.recoverCrashedJobs()
    this.refreshQueues()
  }

  refreshQueues(): void {
    const enabledChats = this.chatSyncState.getEnabledChats()
    for (const chat of enabledChats) {
      this.queueForwardCatchup(chat.chat_id)
    }

    const highPriorityChats = this.chatSyncState.getChatsByPriority(
      SyncPriority.High,
    )
    for (const chat of highPriorityChats) {
      if (!chat.history_complete && chat.synced_messages === 0) {
        this.queueInitialLoad(chat.chat_id)
      }
    }

    const mediumChats = this.chatSyncState.getChatsByPriority(
      SyncPriority.Medium,
    )
    for (const chat of mediumChats) {
      if (!chat.history_complete && chat.synced_messages === 0) {
        this.queueInitialLoad(chat.chat_id)
      }
    }

    const incompleteChats = this.chatSyncState.getIncompleteHistory()
    for (const chat of incompleteChats) {
      if (chat.sync_priority <= SyncPriority.Medium) {
        this.queueBackwardHistory(chat.chat_id)
      }
    }
  }

  getNextJob(): SyncJobRow | null {
    return this.jobsService.getNextPending()
  }

  claimNextJob(): SyncJobRow | null {
    return this.jobsService.claimNextJob()
  }

  startJob(jobId: number): boolean {
    return this.jobsService.markRunning(jobId)
  }

  completeJob(jobId: number): boolean {
    return this.jobsService.markCompleted(jobId)
  }

  failJob(jobId: number, errorMessage: string): boolean {
    return this.jobsService.markFailed(jobId, errorMessage)
  }

  updateProgress(
    jobId: number,
    messagesFetched: number,
    cursor?: number,
  ): void {
    this.jobsService.updateProgress(jobId, {
      messages_fetched: messagesFetched,
      cursor_end: cursor,
    })
  }

  getStatus(): SchedulerStatus {
    const runningJobs = this.jobsService.getRunningJobs()
    const pendingJobs = this.jobsService.getPendingJobs()

    const jobsByType: Record<string, number> = {}
    const jobsByPriority: Record<number, number> = {}

    for (const job of pendingJobs) {
      jobsByType[job.job_type] = (jobsByType[job.job_type] ?? 0) + 1
      jobsByPriority[job.priority] = (jobsByPriority[job.priority] ?? 0) + 1
    }

    return {
      pendingJobs: pendingJobs.length,
      runningJobs: runningJobs.length,
      jobsByType,
      jobsByPriority,
    }
  }

  cleanup(maxAgeMs = 24 * 60 * 60 * 1000): number {
    return this.jobsService.cleanupCompleted(maxAgeMs)
  }

  cancelJobsForChat(chatId: number): number {
    return this.jobsService.cancelPendingForChat(chatId)
  }

  recoverCrashedJobs(): number {
    return this.jobsService.recoverCrashedJobs()
  }
}

export function createSyncScheduler(
  options: SyncSchedulerOptions,
): SyncScheduler {
  return new SyncSchedulerImpl(options)
}
