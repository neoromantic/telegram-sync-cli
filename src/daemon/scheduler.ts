import type { Database } from "bun:sqlite";
import type { ChatSyncStateService } from "../db/chat-sync-state";
import type { MessagesCache } from "../db/messages-cache";
import { createSenderLookups } from "../db/sender-lookups";
import type { SyncJobsService } from "../db/sync-jobs";
import {
  CHAT_INDEPENDENT_JOB_TYPES,
  type ChatSyncStateRow,
  isHistoryAllowed,
  type SyncJobRow,
  SyncJobType,
  SyncPriority,
} from "../db/sync-schema";

/**
 * Scheduler status
 */
export interface SchedulerStatus {
  /** Number of pending jobs */
  pendingJobs: number;
  /** Number of running jobs */
  runningJobs: number;
}

/**
 * Sync scheduler interface
 */
export interface SyncScheduler {
  /** Queue forward catchup job for a chat */
  queueForwardCatchup(chatId: number): void;
  /** Queue backward history sync job for a chat */
  queueBackwardHistory(chatId: number): void;
  /** Queue initial load job for a chat */
  queueInitialLoad(chatId: number): void;
  /** Initialize scheduler with startup jobs */
  initializeForStartup(): Promise<void>;
  /** Refresh job queue based on current sync state */
  refreshQueues(): void;
  /**
   * Next job to process, taking lane turns into account. Only looks: call
   * recordJobRun after running it
   */
  getNextJob(): SyncJobRow | null;
  /**
   * Whether a first page or a history page is due: the account then runs
   * at its adaptive history pace (#133)
   */
  hasHistoryDue(): boolean;
  /** Move to the next lane slot after a job ran */
  recordJobRun(job: SyncJobRow): void;
  /** Get scheduler status */
  getStatus(): SchedulerStatus;
  /** Recover jobs that were running when daemon crashed */
  recoverCrashedJobs(): number;
}

/**
 * Options for creating sync scheduler
 */
export interface SyncSchedulerOptions {
  db: Database;
  jobsService: SyncJobsService;
  chatSyncState: ChatSyncStateService;
  messagesCache: MessagesCache;
}

/**
 * Job lanes. Each lane gets its turns, so a long queue in one lane (for
 * example catch-up after a restart) can't starve the others.
 */
export const SYNC_LANES = {
  catchup: [SyncJobType.ForwardCatchup, SyncJobType.CheckGroupParticipation],
  firstPage: [SyncJobType.InitialLoad, SyncJobType.RefetchMessages],
  history: [SyncJobType.BackwardHistory, SyncJobType.FullSync],
  senders: [SyncJobType.FetchSenders],
} as const satisfies Record<string, readonly SyncJobType[]>;

export type SyncLane = keyof typeof SYNC_LANES;

/**
 * Whose turn each job slot is: half for catch-up, a quarter each for first
 * pages and history when every lane has work.
 */
export const SYNC_SLOT_CYCLE: readonly SyncLane[] = ["catchup", "firstPage", "catchup", "history"];

const SYNC_LANE_FALLBACK: readonly SyncLane[] = ["catchup", "firstPage", "history", "senders"];

/** How often the scheduler looks for senders missing from the cache */
export const SENDER_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

class SyncSchedulerImpl implements SyncScheduler {
  private slot = 0;
  private sendersScannedAt: number | null = null;
  private readonly senderLookups;
  private readonly participation;

  constructor(private readonly options: SyncSchedulerOptions) {
    this.senderLookups = createSenderLookups(options.db);
    this.participation = options.messagesCache.participation;
  }

  private get jobsService() {
    return this.options.jobsService;
  }

  private get chatSyncState() {
    return this.options.chatSyncState;
  }

  private enabledState(chatId: number): ChatSyncStateRow | null {
    const state = this.chatSyncState.get(chatId);
    if (!state?.sync_enabled) return null;
    return this.participation.captures(chatId) ? state : null;
  }

  private dropJobsOfPausedGroups(): void {
    const chats = new Set(
      this.jobsService
        .getPendingJobs()
        .filter((job) => !CHAT_INDEPENDENT_JOB_TYPES.includes(job.job_type))
        .map((job) => job.chat_id),
    );
    for (const chatId of chats) {
      if (!this.participation.captures(chatId)) {
        this.jobsService.cancelPendingForChat(chatId);
      }
    }
  }

  private lanePriority(state: ChatSyncStateRow, jobType: SyncJobType): SyncPriority {
    if (jobType === SyncJobType.InitialLoad && state.sync_mode === "on") {
      return SyncPriority.Realtime;
    }
    return state.sync_priority;
  }

  queueForwardCatchup(chatId: number): void {
    const state = this.enabledState(chatId);
    if (!state) return;

    if (this.jobsService.hasActiveJobForChat(chatId, SyncJobType.ForwardCatchup)) {
      return;
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.ForwardCatchup,
      priority: this.lanePriority(state, SyncJobType.ForwardCatchup),
    });
  }

  queueBackwardHistory(chatId: number): void {
    const state = this.enabledState(chatId);
    if (!state || state.history_complete) return;
    if (!isHistoryAllowed(state)) return;

    if (state.forward_cursor === null) {
      this.queueInitialLoad(chatId);
      return;
    }

    if (this.jobsService.hasActiveJobForChat(chatId, SyncJobType.BackwardHistory)) {
      return;
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.BackwardHistory,
      priority: this.lanePriority(state, SyncJobType.BackwardHistory),
    });
  }

  queueInitialLoad(chatId: number): void {
    const state = this.enabledState(chatId);
    if (!state) return;

    if (this.jobsService.hasActiveJobForChat(chatId, SyncJobType.InitialLoad)) {
      return;
    }

    this.jobsService.create({
      chat_id: chatId,
      job_type: SyncJobType.InitialLoad,
      priority: this.lanePriority(state, SyncJobType.InitialLoad),
    });
  }

  async initializeForStartup(): Promise<void> {
    this.recoverCrashedJobs();
    this.jobsService.deleteFailed();
    this.jobsService.deletePendingOfType(SyncJobType.ForwardCatchup);
    this.jobsService.deletePendingForInactiveChats();
    this.jobsService.alignPendingPriorities();
    this.refreshQueues();
  }

  refreshQueues(): void {
    this.jobsService.deletePendingHistoryOfFirstPageOnlyChats();
    this.dropJobsOfPausedGroups();

    for (const chat of this.chatSyncState.getCatchupDue()) {
      this.queueForwardCatchup(chat.chat_id);
    }

    for (const chat of this.chatSyncState.getInitialLoadDue()) {
      this.queueInitialLoad(chat.chat_id);
    }

    for (const chat of this.chatSyncState.getHistoryDue()) {
      this.queueBackwardHistory(chat.chat_id);
    }

    this.queueSenderFetches();
  }

  private queueSenderFetches(): void {
    const now = Date.now();
    if (this.sendersScannedAt === null || now - this.sendersScannedAt >= SENDER_SCAN_INTERVAL_MS) {
      this.senderLookups.scan(now);
      this.sendersScannedAt = now;
    }
    for (const chatId of this.senderLookups.chatsDue()) {
      if (this.jobsService.hasActiveJobForChat(chatId, SyncJobType.FetchSenders)) {
        continue;
      }
      this.jobsService.create({
        chat_id: chatId,
        job_type: SyncJobType.FetchSenders,
        priority: SyncPriority.Background,
      });
    }
  }

  private nextInLane(lane: SyncLane): SyncJobRow | null {
    return this.jobsService.getNextPendingOfTypes(SYNC_LANES[lane]);
  }

  getNextJob(): SyncJobRow | null {
    const lane = SYNC_SLOT_CYCLE[this.slot % SYNC_SLOT_CYCLE.length]!;
    const job = this.nextInLane(lane);
    if (job) return job;

    for (const fallback of SYNC_LANE_FALLBACK) {
      if (fallback === lane) continue;
      const fallbackJob = this.nextInLane(fallback);
      if (fallbackJob) return fallbackJob;
    }
    return null;
  }

  hasHistoryDue(): boolean {
    return this.nextInLane("firstPage") !== null || this.nextInLane("history") !== null;
  }

  recordJobRun(_job: SyncJobRow): void {
    this.slot = (this.slot + 1) % SYNC_SLOT_CYCLE.length;
  }

  getStatus(): SchedulerStatus {
    return {
      pendingJobs: this.jobsService.getPendingJobs().length,
      runningJobs: this.jobsService.getRunningJobs().length,
    };
  }

  recoverCrashedJobs(): number {
    return this.jobsService.recoverCrashedJobs();
  }
}

export function createSyncScheduler(options: SyncSchedulerOptions): SyncScheduler {
  return new SyncSchedulerImpl(options);
}
