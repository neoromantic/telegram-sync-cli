/**
 * Sync jobs service
 * Manages the job queue for background synchronization
 */
import type { Database } from 'bun:sqlite'
import {
  historyAllowedSql,
  SyncJobRow,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from './sync-schema'

/**
 * Input for creating a sync job
 */
export interface SyncJobInput {
  chat_id: number
  job_type: SyncJobType
  priority: SyncPriority
  cursor_start?: number
  cursor_end?: number
}

/**
 * Progress update for a sync job
 */
export interface SyncJobProgress {
  cursor_start?: number
  cursor_end?: number
  messages_fetched?: number
}

/**
 * A job to run again later, from `retryLater`
 */
export interface SyncJobRetry {
  /** The error, kept as the job's last error; null for none */
  error: string | null
  /** When the job may run again, in ms since the epoch */
  runAt: number
  /** Whether the try counts towards the attempts; a FLOOD_WAIT doesn't */
  countAttempt: boolean
}

/**
 * What `retryLater` did: the job is pending again, it was deleted because
 * its chat was turned off while it ran, or it wasn't running
 */
export type SyncJobRetryResult = 'retrying' | 'cancelled' | 'not_running'

/**
 * What `failOrDrop` did: the job is failed, it was deleted because its chat
 * was turned off while it ran, or it wasn't running
 */
export type SyncJobFailResult = 'failed' | 'cancelled' | 'not_running'

/**
 * Job counts by status. `pending` includes the jobs waiting for a retry;
 * `retrying` counts those that failed at least once.
 */
export interface SyncJobCounts {
  pending: number
  running: number
  failed: number
  retrying: number
}

/**
 * Sync jobs service interface
 */
export interface SyncJobsService {
  /** Create a new sync job */
  create(input: SyncJobInput): SyncJobRow
  /** Get job by ID */
  getById(id: number): SyncJobRow | null
  /** Get the next pending job that is due (highest priority, oldest first) */
  getNextPending(): SyncJobRow | null
  /** Get the next due pending job of the given types (highest priority, oldest first) */
  getNextPendingOfTypes(jobTypes: readonly SyncJobType[]): SyncJobRow | null
  /** Atomically claim the next due pending job (prevents race conditions) */
  claimNextJob(): SyncJobRow | null
  /** Get all pending jobs, including those waiting for a retry */
  getPendingJobs(): SyncJobRow[]
  /** Mark job as running */
  markRunning(id: number): boolean
  /** Mark job as completed */
  markCompleted(id: number): boolean
  /** Mark job as failed, counting the attempt */
  markFailed(id: number, errorMessage: string): boolean
  /**
   * Mark a running job failed, counting the attempt. If its chat was turned
   * off while it ran, delete it instead.
   */
  failOrDrop(id: number, errorMessage: string): SyncJobFailResult
  /**
   * Make a running job pending again, due at `runAt`, at its chat's current
   * lane priority. If its chat was turned off while it ran, delete it instead.
   */
  retryLater(id: number, retry: SyncJobRetry): SyncJobRetryResult
  /** Update job progress */
  updateProgress(id: number, progress: SyncJobProgress): void
  /** Get all running jobs */
  getRunningJobs(): SyncJobRow[]
  /** Get jobs for a specific chat */
  getJobsForChat(chatId: number): SyncJobRow[]
  /**
   * Check if chat has a pending, running or failed job of given type. A
   * failed job holds its chat's slot for that job type until it is deleted.
   */
  hasActiveJobForChat(chatId: number, jobType: SyncJobType): boolean
  /** Clean up old completed jobs */
  cleanupCompleted(olderThanMs: number): number
  /** Clean up old failed jobs */
  cleanupFailed(olderThanMs: number): number
  /** Delete failed jobs of one chat, or of every chat, whatever their age */
  deleteFailed(chatId?: number): number
  /** The newest failed jobs */
  getFailedJobs(limit: number): SyncJobRow[]
  /** Count jobs by status */
  countJobs(): SyncJobCounts
  /** Cancel pending jobs for a chat, except a refetch: it doesn't depend on the mode */
  cancelPendingForChat(chatId: number): number
  /** Delete every pending job of a type */
  deletePendingOfType(jobType: SyncJobType): number
  /**
   * Delete pending jobs of chats that are disabled or have no sync state,
   * except refetches
   */
  deletePendingForInactiveChats(): number
  /**
   * Queue a refetch of the chat's messages cached with raw_json '{}' (#130),
   * unless one is pending. One that is running may have read its IDs
   * already, so it doesn't count. Returns whether it queued one.
   */
  queueRefetch(chatId: number): boolean
  /**
   * Delete pending history jobs of chats the policy gives the newest page
   * only (bots and deleted accounts, unless turned on by hand)
   */
  deletePendingHistoryOfFirstPageOnlyChats(): number
  /** Set each pending job's priority to its chat's lane priority */
  alignPendingPriorities(): number
  /** Recover jobs that were running when daemon crashed (reset to pending) */
  recoverCrashedJobs(): number
}

/**
 * Create a sync jobs service
 */
export function createSyncJobsService(db: Database): SyncJobsService {
  const stmts = {
    create: db.prepare(`
      INSERT INTO sync_jobs (chat_id, job_type, priority, status, cursor_start, cursor_end, created_at)
      VALUES ($chat_id, $job_type, $priority, $status, $cursor_start, $cursor_end, $now)
    `),

    getById: db
      .query(`
      SELECT * FROM sync_jobs WHERE id = $id
    `)
      .as(SyncJobRow),

    getNextPending: db
      .query(`
      SELECT * FROM sync_jobs
      WHERE status = $status AND next_run_at <= $now
      ORDER BY priority ASC, created_at ASC, id ASC
      LIMIT 1
    `)
      .as(SyncJobRow),

    claimNextJob: db
      .query(`
      UPDATE sync_jobs
      SET status = $newStatus, started_at = $now
      WHERE id = (
        SELECT id FROM sync_jobs
        WHERE status = $pendingStatus AND next_run_at <= $now
        ORDER BY priority ASC, created_at ASC, id ASC
        LIMIT 1
      )
      AND status = $pendingStatus
      RETURNING *
    `)
      .as(SyncJobRow),

    getPendingJobs: db
      .query(`
      SELECT * FROM sync_jobs
      WHERE status = $status
      ORDER BY priority ASC, created_at ASC, id ASC
    `)
      .as(SyncJobRow),

    markRunning: db.prepare(`
      UPDATE sync_jobs
      SET status = $status, started_at = $now
      WHERE id = $id AND status = $expected_status
    `),

    markCompleted: db.prepare(`
      UPDATE sync_jobs
      SET status = $status, completed_at = $now
      WHERE id = $id AND status = $expected_status
    `),

    markFailed: db.prepare(`
      UPDATE sync_jobs
      SET status = $status, error_message = $error, completed_at = $now,
          attempts = attempts + 1
      WHERE id = $id AND status = $expected_status
    `),

    // A refetch runs whether its chat syncs or not
    failIfEnabled: db.prepare(`
      UPDATE sync_jobs
      SET status = $status, error_message = $error, completed_at = $now,
          attempts = attempts + 1
      WHERE id = $id AND status = $expected_status
        AND (job_type = '${SyncJobType.RefetchMessages}' OR EXISTS (
          SELECT 1 FROM chat_sync_state s
          WHERE s.chat_id = sync_jobs.chat_id AND s.sync_enabled = 1
        ))
    `),

    // The chat's mode may have changed while the job ran, and tg chats sync
    // cancels only pending jobs, so the retry takes the chat's lane priority
    // now, like alignPendingPriorities. A refetch keeps its own.
    retryLater: db.prepare(`
      UPDATE sync_jobs
      SET status = $pending_status, attempts = attempts + $inc,
          next_run_at = $run_at, error_message = $error, started_at = NULL,
          priority = CASE WHEN job_type = '${SyncJobType.RefetchMessages}'
            THEN priority
            ELSE COALESCE((
              SELECT CASE
                WHEN sync_jobs.job_type = 'initial_load' AND s.sync_mode = 'on' THEN 0
                ELSE s.sync_priority
              END
              FROM chat_sync_state s
              WHERE s.chat_id = sync_jobs.chat_id
            ), priority)
          END
      WHERE id = $id AND status = $running_status
        AND (job_type = '${SyncJobType.RefetchMessages}' OR EXISTS (
          SELECT 1 FROM chat_sync_state s
          WHERE s.chat_id = sync_jobs.chat_id AND s.sync_enabled = 1
        ))
    `),

    deleteRunning: db.prepare(`
      DELETE FROM sync_jobs WHERE id = $id AND status = $running_status
    `),

    updateProgress: db.prepare(`
      UPDATE sync_jobs
      SET cursor_start = COALESCE($cursor_start, cursor_start),
          cursor_end = COALESCE($cursor_end, cursor_end),
          messages_fetched = messages_fetched + COALESCE($messages, 0)
      WHERE id = $id
    `),

    getRunningJobs: db
      .query(`
      SELECT * FROM sync_jobs WHERE status = $status
    `)
      .as(SyncJobRow),

    getJobsForChat: db
      .query(`
      SELECT * FROM sync_jobs WHERE chat_id = $chat_id ORDER BY created_at DESC
    `)
      .as(SyncJobRow),

    hasActiveJobForChat: db.query(`
      SELECT 1 FROM sync_jobs
      WHERE chat_id = $chat_id
        AND job_type = $job_type
        AND status IN ($pending_status, $running_status, $failed_status)
      LIMIT 1
    `),

    cleanupCompleted: db.prepare(`
      DELETE FROM sync_jobs
      WHERE status = $status AND completed_at < $before
    `),

    cleanupFailed: db.prepare(`
      DELETE FROM sync_jobs
      WHERE status = $status AND completed_at < $before
    `),

    deleteFailed: db.prepare(`
      DELETE FROM sync_jobs WHERE status = $status
    `),

    deleteFailedForChat: db.prepare(`
      DELETE FROM sync_jobs WHERE status = $status AND chat_id = $chat_id
    `),

    getFailedJobs: db
      .query(`
      SELECT * FROM sync_jobs
      WHERE status = $status
      ORDER BY completed_at DESC, id DESC
      LIMIT $limit
    `)
      .as(SyncJobRow),

    countJobs: db.query(`
      SELECT
        COALESCE(SUM(status = $pending_status), 0) AS pending,
        COALESCE(SUM(status = $running_status), 0) AS running,
        COALESCE(SUM(status = $failed_status), 0) AS failed,
        COALESCE(SUM(status = $pending_status AND attempts > 0), 0) AS retrying
      FROM sync_jobs
    `),

    cancelPendingForChat: db.prepare(`
      DELETE FROM sync_jobs
      WHERE chat_id = $chat_id AND status = $status
        AND job_type != '${SyncJobType.RefetchMessages}'
    `),

    deletePendingOfType: db.prepare(`
      DELETE FROM sync_jobs
      WHERE job_type = $job_type AND status = $status
    `),

    deletePendingForInactiveChats: db.prepare(`
      DELETE FROM sync_jobs
      WHERE status = $status
        AND job_type != '${SyncJobType.RefetchMessages}'
        AND NOT EXISTS (
          SELECT 1 FROM chat_sync_state s
          WHERE s.chat_id = sync_jobs.chat_id AND s.sync_enabled = 1
        )
    `),

    deletePendingHistoryOfFirstPageOnlyChats: db.prepare(`
      DELETE FROM sync_jobs
      WHERE status = $status
        AND job_type IN ($backward, $full)
        AND EXISTS (
          SELECT 1 FROM chat_sync_state s
          WHERE s.chat_id = sync_jobs.chat_id AND NOT ${historyAllowedSql('s')}
        )
    `),

    alignPendingPriorities: db.prepare(`
      UPDATE sync_jobs
      SET priority = (
        SELECT CASE
          WHEN sync_jobs.job_type = 'initial_load' AND s.sync_mode = 'on' THEN 0
          ELSE s.sync_priority
        END
        FROM chat_sync_state s
        WHERE s.chat_id = sync_jobs.chat_id
      )
      WHERE status = $status
        AND job_type != '${SyncJobType.RefetchMessages}'
        AND EXISTS (
          SELECT 1 FROM chat_sync_state s WHERE s.chat_id = sync_jobs.chat_id
        )
    `),

    queueRefetch: db.prepare(`
      INSERT INTO sync_jobs (chat_id, job_type, priority, status, created_at)
      SELECT $chat_id, $job_type, $priority, $pending_status, $now
      WHERE NOT EXISTS (
        SELECT 1 FROM sync_jobs
        WHERE chat_id = $chat_id AND job_type = $job_type
          AND status = $pending_status
      )
    `),

    recoverCrashedJobs: db.prepare(`
      UPDATE sync_jobs
      SET status = $newStatus, error_message = $error
      WHERE status = $oldStatus
    `),

    getLastInsertId: db.query(`SELECT last_insert_rowid() as id`),
  }

  /**
   * Delete a running job whose chat was turned off. Each statement is atomic,
   * and tg chats sync turns a chat off in an IMMEDIATE transaction, so the
   * guarded update before this and the mode change can't interleave.
   */
  function dropRunning(id: number): 'cancelled' | 'not_running' {
    const deleted = stmts.deleteRunning.run({
      $id: id,
      $running_status: SyncJobStatus.Running,
    })
    return deleted.changes === 1 ? 'cancelled' : 'not_running'
  }

  return {
    create(input: SyncJobInput): SyncJobRow {
      const now = Date.now()
      stmts.create.run({
        $chat_id: input.chat_id,
        $job_type: input.job_type,
        $priority: input.priority,
        $status: SyncJobStatus.Pending,
        $cursor_start: input.cursor_start ?? null,
        $cursor_end: input.cursor_end ?? null,
        $now: now,
      })

      const result = stmts.getLastInsertId.get() as { id: number }
      return this.getById(result.id)!
    },

    getById(id: number): SyncJobRow | null {
      return stmts.getById.get({ $id: id }) ?? null
    },

    getNextPending(): SyncJobRow | null {
      return (
        stmts.getNextPending.get({
          $status: SyncJobStatus.Pending,
          $now: Date.now(),
        }) ?? null
      )
    },

    getNextPendingOfTypes(jobTypes: readonly SyncJobType[]): SyncJobRow | null {
      if (jobTypes.length === 0) return null
      const placeholders = jobTypes.map((_, i) => `$type${i}`).join(', ')
      const params: Record<string, string | number> = {
        $status: SyncJobStatus.Pending,
        $now: Date.now(),
      }
      jobTypes.forEach((jobType, i) => {
        params[`$type${i}`] = jobType
      })
      // query() caches the statement per SQL text, so each lane prepares once.
      return (
        db
          .query(`
            SELECT * FROM sync_jobs
            WHERE status = $status AND next_run_at <= $now
              AND job_type IN (${placeholders})
            ORDER BY priority ASC, created_at ASC, id ASC
            LIMIT 1
          `)
          .as(SyncJobRow)
          .get(params) ?? null
      )
    },

    claimNextJob(): SyncJobRow | null {
      return (
        stmts.claimNextJob.get({
          $pendingStatus: SyncJobStatus.Pending,
          $newStatus: SyncJobStatus.Running,
          $now: Date.now(),
        }) ?? null
      )
    },

    getPendingJobs(): SyncJobRow[] {
      return stmts.getPendingJobs.all({ $status: SyncJobStatus.Pending })
    },

    markRunning(id: number): boolean {
      const result = stmts.markRunning.run({
        $id: id,
        $status: SyncJobStatus.Running,
        $expected_status: SyncJobStatus.Pending,
        $now: Date.now(),
      })
      return result.changes === 1
    },

    markCompleted(id: number): boolean {
      const result = stmts.markCompleted.run({
        $id: id,
        $status: SyncJobStatus.Completed,
        $expected_status: SyncJobStatus.Running,
        $now: Date.now(),
      })
      return result.changes === 1
    },

    markFailed(id: number, errorMessage: string): boolean {
      const result = stmts.markFailed.run({
        $id: id,
        $status: SyncJobStatus.Failed,
        $expected_status: SyncJobStatus.Running,
        $error: errorMessage,
        $now: Date.now(),
      })
      return result.changes === 1
    },

    failOrDrop(id: number, errorMessage: string): SyncJobFailResult {
      const updated = stmts.failIfEnabled.run({
        $id: id,
        $status: SyncJobStatus.Failed,
        $expected_status: SyncJobStatus.Running,
        $error: errorMessage,
        $now: Date.now(),
      })
      return updated.changes === 1 ? 'failed' : dropRunning(id)
    },

    retryLater(id: number, retry: SyncJobRetry): SyncJobRetryResult {
      const updated = stmts.retryLater.run({
        $id: id,
        $pending_status: SyncJobStatus.Pending,
        $running_status: SyncJobStatus.Running,
        $inc: retry.countAttempt ? 1 : 0,
        $run_at: retry.runAt,
        $error: retry.error,
      })
      return updated.changes === 1 ? 'retrying' : dropRunning(id)
    },

    updateProgress(id: number, progress: SyncJobProgress): void {
      stmts.updateProgress.run({
        $id: id,
        $cursor_start: progress.cursor_start ?? null,
        $cursor_end: progress.cursor_end ?? null,
        $messages: progress.messages_fetched ?? null,
      })
    },

    getRunningJobs(): SyncJobRow[] {
      return stmts.getRunningJobs.all({ $status: SyncJobStatus.Running })
    },

    getJobsForChat(chatId: number): SyncJobRow[] {
      return stmts.getJobsForChat.all({ $chat_id: chatId })
    },

    hasActiveJobForChat(chatId: number, jobType: SyncJobType): boolean {
      const result = stmts.hasActiveJobForChat.get({
        $chat_id: chatId,
        $job_type: jobType,
        $pending_status: SyncJobStatus.Pending,
        $running_status: SyncJobStatus.Running,
        $failed_status: SyncJobStatus.Failed,
      })
      return result !== null
    },

    cleanupCompleted(olderThanMs: number): number {
      const before = Date.now() - olderThanMs
      const result = stmts.cleanupCompleted.run({
        $status: SyncJobStatus.Completed,
        $before: before,
      })
      return result.changes
    },

    cleanupFailed(olderThanMs: number): number {
      const before = Date.now() - olderThanMs
      const result = stmts.cleanupFailed.run({
        $status: SyncJobStatus.Failed,
        $before: before,
      })
      return result.changes
    },

    deleteFailed(chatId?: number): number {
      if (chatId === undefined) {
        return stmts.deleteFailed.run({ $status: SyncJobStatus.Failed }).changes
      }
      return stmts.deleteFailedForChat.run({
        $status: SyncJobStatus.Failed,
        $chat_id: chatId,
      }).changes
    },

    getFailedJobs(limit: number): SyncJobRow[] {
      return stmts.getFailedJobs.all({
        $status: SyncJobStatus.Failed,
        $limit: limit,
      })
    },

    countJobs(): SyncJobCounts {
      return stmts.countJobs.get({
        $pending_status: SyncJobStatus.Pending,
        $running_status: SyncJobStatus.Running,
        $failed_status: SyncJobStatus.Failed,
      }) as SyncJobCounts
    },

    cancelPendingForChat(chatId: number): number {
      const result = stmts.cancelPendingForChat.run({
        $chat_id: chatId,
        $status: SyncJobStatus.Pending,
      })
      return result.changes
    },

    deletePendingOfType(jobType: SyncJobType): number {
      const result = stmts.deletePendingOfType.run({
        $job_type: jobType,
        $status: SyncJobStatus.Pending,
      })
      return result.changes
    },

    deletePendingForInactiveChats(): number {
      return stmts.deletePendingForInactiveChats.run({
        $status: SyncJobStatus.Pending,
      }).changes
    },

    queueRefetch(chatId: number): boolean {
      return (
        stmts.queueRefetch.run({
          $chat_id: chatId,
          $job_type: SyncJobType.RefetchMessages,
          $priority: SyncPriority.Background,
          $pending_status: SyncJobStatus.Pending,
          $now: Date.now(),
        }).changes === 1
      )
    },

    deletePendingHistoryOfFirstPageOnlyChats(): number {
      return stmts.deletePendingHistoryOfFirstPageOnlyChats.run({
        $status: SyncJobStatus.Pending,
        $backward: SyncJobType.BackwardHistory,
        $full: SyncJobType.FullSync,
      }).changes
    },

    alignPendingPriorities(): number {
      return stmts.alignPendingPriorities.run({
        $status: SyncJobStatus.Pending,
      }).changes
    },

    recoverCrashedJobs(): number {
      const result = stmts.recoverCrashedJobs.run({
        $oldStatus: SyncJobStatus.Running,
        $newStatus: SyncJobStatus.Pending,
        $error: 'Daemon crashed during execution',
      })
      return result.changes
    },
  }
}

export { SyncJobStatus, SyncJobType, SyncPriority }
