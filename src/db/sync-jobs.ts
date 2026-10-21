/**
 * Sync jobs service
 * Manages the job queue for background synchronization
 */
import type { Database } from 'bun:sqlite'
import {
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
 * Sync jobs service interface
 */
export interface SyncJobsService {
  /** Create a new sync job */
  create(input: SyncJobInput): SyncJobRow
  /** Get job by ID */
  getById(id: number): SyncJobRow | null
  /** Get the next pending job (highest priority, oldest first) */
  getNextPending(): SyncJobRow | null
  /** Get the next pending job of the given types (highest priority, oldest first) */
  getNextPendingOfTypes(jobTypes: readonly SyncJobType[]): SyncJobRow | null
  /** Atomically claim the next pending job (prevents race conditions) */
  claimNextJob(): SyncJobRow | null
  /** Get all pending jobs */
  getPendingJobs(): SyncJobRow[]
  /** Mark job as running */
  markRunning(id: number): boolean
  /** Mark job as completed */
  markCompleted(id: number): boolean
  /** Mark job as failed */
  markFailed(id: number, errorMessage: string): boolean
  /** Update job progress */
  updateProgress(id: number, progress: SyncJobProgress): void
  /** Get all running jobs */
  getRunningJobs(): SyncJobRow[]
  /** Get jobs for a specific chat */
  getJobsForChat(chatId: number): SyncJobRow[]
  /** Check if chat has pending or running job of given type */
  hasActiveJobForChat(chatId: number, jobType: SyncJobType): boolean
  /** Clean up old completed jobs */
  cleanupCompleted(olderThanMs: number): number
  /** Clean up old failed jobs */
  cleanupFailed(olderThanMs: number): number
  /** Cancel pending jobs for a chat */
  cancelPendingForChat(chatId: number): number
  /** Delete every pending job of a type */
  deletePendingOfType(jobType: SyncJobType): number
  /** Delete pending jobs of chats that are disabled or have no sync state */
  deletePendingForInactiveChats(): number
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
      WHERE status = $status
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
        WHERE status = $pendingStatus
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
      SET status = $status, error_message = $error, completed_at = $now
      WHERE id = $id AND status = $expected_status
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
        AND status IN ($pending_status, $running_status)
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

    cancelPendingForChat: db.prepare(`
      DELETE FROM sync_jobs
      WHERE chat_id = $chat_id AND status = $status
    `),

    deletePendingOfType: db.prepare(`
      DELETE FROM sync_jobs
      WHERE job_type = $job_type AND status = $status
    `),

    deletePendingForInactiveChats: db.prepare(`
      DELETE FROM sync_jobs
      WHERE status = $status
        AND NOT EXISTS (
          SELECT 1 FROM chat_sync_state s
          WHERE s.chat_id = sync_jobs.chat_id AND s.sync_enabled = 1
        )
    `),

    alignPendingPriorities: db.prepare(`
      UPDATE sync_jobs
      SET priority = (
        SELECT s.sync_priority FROM chat_sync_state s
        WHERE s.chat_id = sync_jobs.chat_id
      )
      WHERE status = $status
        AND EXISTS (
          SELECT 1 FROM chat_sync_state s WHERE s.chat_id = sync_jobs.chat_id
        )
    `),

    recoverCrashedJobs: db.prepare(`
      UPDATE sync_jobs
      SET status = $newStatus, error_message = $error
      WHERE status = $oldStatus
    `),

    getLastInsertId: db.query(`SELECT last_insert_rowid() as id`),
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
        stmts.getNextPending.get({ $status: SyncJobStatus.Pending }) ?? null
      )
    },

    getNextPendingOfTypes(jobTypes: readonly SyncJobType[]): SyncJobRow | null {
      if (jobTypes.length === 0) return null
      const placeholders = jobTypes.map((_, i) => `$type${i}`).join(', ')
      const params: Record<string, string> = { $status: SyncJobStatus.Pending }
      jobTypes.forEach((jobType, i) => {
        params[`$type${i}`] = jobType
      })
      // query() caches the statement per SQL text, so each lane prepares once.
      return (
        db
          .query(`
            SELECT * FROM sync_jobs
            WHERE status = $status AND job_type IN (${placeholders})
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
