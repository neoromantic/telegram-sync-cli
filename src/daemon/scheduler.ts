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
  isHistoryAllowed,
  type SyncJobRow,
  SyncJobType,
  SyncPriority,
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
  /**
   * Whether a first page or a history page is due: the account then runs
   * at its adaptive history pace (#133)
   */
  hasHistoryDue(): boolean
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
  /** Delete completed and failed jobs older than maxAgeMs (default 24 h) */
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
  // A refetch (#130) is one small request per chat, at the lowest priority
  firstPage: [SyncJobType.InitialLoad, SyncJobType.RefetchMessages],
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
   * medium groups. A chat turned on by hand gets its first page ahead of
   * everything, so the user sees it soon.
   */
  private lanePriority(
    state: ChatSyncStateRow,
    jobType: SyncJobType,
  ): SyncPriority {
    if (jobType === SyncJobType.InitialLoad && state.sync_mode === 'on') {
      return SyncPriority.Realtime
    }
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
      priority: this.lanePriority(state, SyncJobType.ForwardCatchup),
    })
  }

  queueBackwardHistory(chatId: number): void {
    const state = this.enabledState(chatId)
    if (!state || state.history_complete) return
    // Bots and deleted accounts get their first page only (#131)
    if (!isHistoryAllowed(state)) return

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
      priority: this.lanePriority(state, SyncJobType.BackwardHistory),
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
      priority: this.lanePriority(state, SyncJobType.InitialLoad),
    })
  }

  async initializeForStartup(): Promise<void> {
    // A crash doesn't count as an attempt.
    this.recoverCrashedJobs()
    // A restart retries every failed job, and removes the failed rows older
    // versions left: refreshQueues below queues their chats again.
    this.jobsService.deleteFailed()
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
   * A chat whose job of a type failed for good gets no new job of that type
   * until the failed row is deleted.
   */
  refreshQueues(): void {
    // A dialog pass may have found that a chat is a bot or a deleted
    // account, which gets no older history (#131): its pending history jobs
    // go, its cached messages stay.
    this.jobsService.deletePendingHistoryOfFirstPageOnlyChats()

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

  /** The lane's next job that is due; jobs waiting for a retry are skipped */
  private nextInLane(lane: SyncLane): SyncJobRow | null {
    return this.jobsService.getNextPendingOfTypes(SYNC_LANES[lane])
  }

  /**
   * The next job: the oldest, highest-priority due job of the lane whose
   * slot it is, or of the first lane with work if that lane has none due.
   * Only looks; recordJobRun moves to the next slot.
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

  hasHistoryDue(): boolean {
    return (
      this.nextInLane('firstPage') !== null ||
      this.nextInLane('history') !== null
    )
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
    return (
      this.jobsService.cleanupCompleted(maxAgeMs) +
      this.jobsService.cleanupFailed(maxAgeMs)
    )
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
