/**
 * Sync scheduler for managing background synchronization jobs
 * Queues the work that is due and hands out jobs in three lanes that take
 * turns: forward catch-up, first pages and history.
 */
import type { Database } from 'bun:sqlite'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { MessagesCache } from '../db/messages-cache'
import type { SyncJobsService } from '../db/sync-jobs'
import {
  type ChatSyncStateRow,
  type SyncJobRow,
  SyncJobType,
  type SyncPriority,
} from '../db/sync-schema'

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
  /**
   * Next job to process, taking lane turns into account. Only looks: call
   * recordJobRun after running it (non-atomic, use claimNextJob for
   * concurrent safety)
   */
  getNextJob(): SyncJobRow | null
  /** Move to the next lane slot after a job ran */
  recordJobRun(job: SyncJobRow): void
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
 * Job lanes. Each lane gets its turns, so a long queue in one lane (for
 * example catch-up after a restart) can't starve the others.
 */
export const SYNC_LANES = {
  catchup: [SyncJobType.ForwardCatchup],
  firstPage: [SyncJobType.InitialLoad],
  history: [SyncJobType.BackwardHistory, SyncJobType.FullSync],
} as const satisfies Record<string, readonly SyncJobType[]>

export type SyncLane = keyof typeof SYNC_LANES

/**
 * Whose turn each job slot is: half for catch-up, a quarter each for first
 * pages and history when every lane has work.
 */
export const SYNC_SLOT_CYCLE: readonly SyncLane[] = [
  'catchup',
  'firstPage',
  'catchup',
  'history',
]

/** Who gets an empty lane's slot */
const SYNC_LANE_FALLBACK: readonly SyncLane[] = [
  'catchup',
  'firstPage',
  'history',
]

/**
 * Create sync scheduler
 */
class SyncSchedulerImpl implements SyncScheduler {
  /** Position in SYNC_SLOT_CYCLE; in memory, so it restarts with the daemon */
  private slot = 0

  constructor(private readonly options: SyncSchedulerOptions) {}

  private get jobsService() {
    return this.options.jobsService
  }

  private get chatSyncState() {
    return this.options.chatSyncState
  }

  /** The chat's sync state, if it exists and sync is on */
  private enabledState(chatId: number): ChatSyncStateRow | null {
    const state = this.chatSyncState.get(chatId)
    return state?.sync_enabled ? state : null
  }

  /**
   * A job's priority inside its lane is its chat's tier: small chats before
   * medium groups.
   */
  private lanePriority(state: ChatSyncStateRow): SyncPriority {
    return state.sync_priority
  }

  queueForwardCatchup(chatId: number): void {
    const state = this.enabledState(chatId)
    if (!state) return

    if (
      this.jobsService.hasActiveJobForChat(chatId, SyncJobType.ForwardCatchup)
    ) {
      return
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.ForwardCatchup,
      priority: this.lanePriority(state),
    })
  }

  queueBackwardHistory(chatId: number): void {
    const state = this.enabledState(chatId)
    if (!state || state.history_complete) return

    // The first page sets both cursors, so it comes before any history.
    if (state.forward_cursor === null) {
      this.queueInitialLoad(chatId)
      return
    }

    if (
      this.jobsService.hasActiveJobForChat(chatId, SyncJobType.BackwardHistory)
    ) {
      return
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: this.lanePriority(state),
    })
  }

  queueInitialLoad(chatId: number): void {
    const state = this.enabledState(chatId)
    if (!state) return

    if (this.jobsService.hasActiveJobForChat(chatId, SyncJobType.InitialLoad)) {
      return
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.InitialLoad,
      priority: this.lanePriority(state),
    })
  }

  async initializeForStartup(): Promise<void> {
    this.recoverCrashedJobs()
    // Catch-up is queued again below for the chats that are behind; older
    // versions left one pending for every enabled chat.
    this.jobsService.deletePendingOfType(SyncJobType.ForwardCatchup)
    this.jobsService.deletePendingForInactiveChats()
    this.jobsService.alignPendingPriorities()
    this.refreshQueues()
  }

  /**
   * Queue the work that is due. Called on start, after a reconnect's dialog
   * pass and every 30 loop ticks; a chat with nothing to do costs no call.
   */
  refreshQueues(): void {
    // Catch-up only for chats whose newest message is above the cursor or
    // unknown. Live updates don't move the cursor or the top, so a chat
    // that is caught up stays that way until a dialog pass sees more.
    for (const chat of this.chatSyncState.getCatchupDue()) {
      this.queueForwardCatchup(chat.chat_id)
    }

    // Every enabled chat without a forward cursor gets its first page, even
    // if live updates already cached some of its messages.
    for (const chat of this.chatSyncState.getInitialLoadDue()) {
      this.queueInitialLoad(chat.chat_id)
    }

    // History for every enabled chat that had its first page, in any tier.
    for (const chat of this.chatSyncState.getHistoryDue()) {
      this.queueBackwardHistory(chat.chat_id)
    }
  }

  private nextInLane(lane: SyncLane): SyncJobRow | null {
    return this.jobsService.getNextPendingOfTypes(SYNC_LANES[lane])
  }

  /**
   * The next job: the oldest, highest-priority job of the lane whose slot
   * it is, or of the first lane with work if that lane is empty. Only
   * looks; recordJobRun moves to the next slot.
   */
  getNextJob(): SyncJobRow | null {
    const lane = SYNC_SLOT_CYCLE[this.slot % SYNC_SLOT_CYCLE.length]!
    const job = this.nextInLane(lane)
    if (job) return job

    for (const fallback of SYNC_LANE_FALLBACK) {
      if (fallback === lane) continue
      const fallbackJob = this.nextInLane(fallback)
      if (fallbackJob) return fallbackJob
    }
    return null
  }

  recordJobRun(_job: SyncJobRow): void {
    this.slot = (this.slot + 1) % SYNC_SLOT_CYCLE.length
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
