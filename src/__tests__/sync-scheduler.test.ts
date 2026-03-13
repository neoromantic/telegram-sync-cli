/**
 * Tests for sync scheduler
 */
import { Database } from 'bun:sqlite'
import { beforeEach, describe, expect, it } from 'bun:test'
import { createSyncScheduler, type SyncScheduler } from '../daemon/scheduler'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  SyncJobStatus,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'

describe('SyncScheduler', () => {
  let db: Database
  let scheduler: SyncScheduler
  let jobsService: ReturnType<typeof createSyncJobsService>
  let chatSyncState: ReturnType<typeof createChatSyncStateService>
  let messagesCache: ReturnType<typeof createMessagesCache>

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    jobsService = createSyncJobsService(db)
    chatSyncState = createChatSyncStateService(db)
    messagesCache = createMessagesCache(db)
    scheduler = createSyncScheduler({
      db,
      jobsService,
      chatSyncState,
      messagesCache,
    })
  })

  describe('queueForwardCatchup', () => {
    it('queues forward catchup job for a chat', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      scheduler.queueForwardCatchup(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.ForwardCatchup)
      expect(jobs[0]!.priority).toBe(SyncPriority.Realtime)
    })

    it('does not queue duplicate catchup job', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      scheduler.queueForwardCatchup(100)
      scheduler.queueForwardCatchup(100) // Duplicate

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
    })
  })

  describe('queueBackwardHistory', () => {
    it('queues backward history job for a chat with existing backward_cursor', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        backward_cursor: 500, // Has an existing cursor
      })

      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.BackwardHistory)
      expect(jobs[0]!.priority).toBe(SyncPriority.Background)
    })

    it('does not queue if history is complete', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      chatSyncState.markHistoryComplete(100)

      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(0)
    })

    it('queues initial load instead when backward_cursor is null and no cached messages (issue-6 fix)', () => {
      // Set up chat with no backward cursor (null by default) and no cached messages
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        // backward_cursor defaults to null
      })

      // Try to queue backward history - should queue initial load instead
      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.InitialLoad)
      // Should use the chat's sync priority
      expect(jobs[0]!.priority).toBe(SyncPriority.High)
    })

    it('queues backward history when backward_cursor is null but cached messages exist (issue-6 fix)', () => {
      // Set up chat with no backward cursor but WITH cached messages
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      // Add a cached message
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1000,
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      // Queue backward history - should work since we have cached messages
      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.BackwardHistory)
    })

    it('queues backward history when backward_cursor exists (issue-6 fix)', () => {
      // Set up chat WITH a backward cursor
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        backward_cursor: 500, // Has a valid cursor
      })

      // Queue backward history - should work since we have a cursor
      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.BackwardHistory)
    })

    it('does not queue duplicate initial load when backward_cursor is null (issue-6 fix)', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      // Queue backward history twice - should only create one initial load
      scheduler.queueBackwardHistory(100)
      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.InitialLoad)
    })
  })

  describe('queueInitialLoad', () => {
    it('queues initial load job', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'group',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        member_count: 50,
      })

      scheduler.queueInitialLoad(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.InitialLoad)
    })
  })

  describe('initializeForStartup', () => {
    beforeEach(() => {
      // Create some chats with sync enabled
      chatSyncState.upsert({
        chat_id: 1,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      chatSyncState.upsert({
        chat_id: 2,
        chat_type: 'group',
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        member_count: 50,
      })
      chatSyncState.upsert({
        chat_id: 3,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: false, // Disabled
      })
    })

    it('queues forward catchup for enabled chats', async () => {
      await scheduler.initializeForStartup()

      // Check jobs were created for enabled chats
      expect(jobsService.getJobsForChat(1).length).toBeGreaterThan(0)
      expect(jobsService.getJobsForChat(2).length).toBeGreaterThan(0)
      // Disabled chat should not have jobs
      expect(jobsService.getJobsForChat(3).length).toBe(0)
    })

    it('queues initial load for high priority chats with no synced messages', async () => {
      await scheduler.initializeForStartup()

      // Chat 1 is high priority (private DM) with synced_messages = 0
      const jobs = jobsService.getJobsForChat(1)
      const initialLoadJobs = jobs.filter(
        (j) => j.job_type === SyncJobType.InitialLoad,
      )
      expect(initialLoadJobs).toHaveLength(1)
      expect(initialLoadJobs[0]!.priority).toBe(SyncPriority.High)
    })

    it('queues initial load for medium priority chats with no synced messages', async () => {
      await scheduler.initializeForStartup()

      // Chat 2 is medium priority (group) with synced_messages = 0
      const jobs = jobsService.getJobsForChat(2)
      const initialLoadJobs = jobs.filter(
        (j) => j.job_type === SyncJobType.InitialLoad,
      )
      expect(initialLoadJobs).toHaveLength(1)
      expect(initialLoadJobs[0]!.priority).toBe(SyncPriority.Medium)
    })

    it('does not queue initial load for chats with synced messages', async () => {
      // Add synced messages to high priority chat
      chatSyncState.incrementSyncedMessages(1, 5)
      // Also add a cached message so queueBackwardHistory doesn't trigger ISSUE-6 initial load
      messagesCache.upsert({
        chat_id: 1,
        message_id: 100,
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      await scheduler.initializeForStartup()

      // Chat 1 has synced messages, should not get initial load
      const jobs = jobsService.getJobsForChat(1)
      const initialLoadJobs = jobs.filter(
        (j) => j.job_type === SyncJobType.InitialLoad,
      )
      expect(initialLoadJobs).toHaveLength(0)
    })

    it('does not queue initial load for chats with complete history', async () => {
      // Mark high priority chat as history complete
      chatSyncState.markHistoryComplete(1)

      await scheduler.initializeForStartup()

      // Chat 1 has complete history, should not get initial load
      const jobs = jobsService.getJobsForChat(1)
      const initialLoadJobs = jobs.filter(
        (j) => j.job_type === SyncJobType.InitialLoad,
      )
      expect(initialLoadJobs).toHaveLength(0)
    })
  })

  describe('getNextJob', () => {
    it('returns highest priority job first', () => {
      // Queue jobs with different priorities
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })
      jobsService.create({
        chat_id: 300,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.Medium,
      })

      const nextJob = scheduler.getNextJob()
      expect(nextJob).not.toBeNull()
      expect(nextJob?.chat_id).toBe(200) // Realtime priority is highest
    })

    it('returns null when no pending jobs', () => {
      expect(scheduler.getNextJob()).toBeNull()
    })
  })

  describe('claimNextJob', () => {
    it('atomically claims and starts the highest priority job', () => {
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.Realtime,
      })

      const claimed = scheduler.claimNextJob()

      expect(claimed).not.toBeNull()
      expect(claimed?.chat_id).toBe(200)
      expect(claimed?.status).toBe(SyncJobStatus.Running)
    })

    it('returns null when no pending jobs', () => {
      expect(scheduler.claimNextJob()).toBeNull()
    })

    it('prevents race condition - only one worker gets the job', () => {
      // Create a single job
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })

      // Simulate concurrent workers claiming
      const claim1 = scheduler.claimNextJob()
      const claim2 = scheduler.claimNextJob()

      // Only first claim should succeed
      expect(claim1).not.toBeNull()
      expect(claim2).toBeNull()

      // Verify job is running
      const status = scheduler.getStatus()
      expect(status.runningJobs).toBe(1)
      expect(status.pendingJobs).toBe(0)
    })
  })

  describe('completeJob', () => {
    it('marks job as completed', () => {
      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      jobsService.markRunning(job.id)

      scheduler.completeJob(job.id)

      const updated = jobsService.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Completed)
    })
  })

  describe('failJob', () => {
    it('marks job as failed with error message', () => {
      const job = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      jobsService.markRunning(job.id)

      scheduler.failJob(job.id, 'Network error')

      const updated = jobsService.getById(job.id)
      expect(updated?.status).toBe(SyncJobStatus.Failed)
      expect(updated?.error_message).toBe('Network error')
    })
  })

  describe('getStatus', () => {
    it('returns current scheduler status', () => {
      // Add some jobs
      jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const runningJob = jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      jobsService.markRunning(runningJob.id)

      const status = scheduler.getStatus()

      expect(status.pendingJobs).toBe(1)
      expect(status.runningJobs).toBe(1)
    })
  })

  describe('recoverCrashedJobs', () => {
    it('recovers running jobs from crashed daemon', () => {
      const job1 = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.ForwardCatchup,
        priority: SyncPriority.High,
      })
      const job2 = jobsService.create({
        chat_id: 200,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })

      // Simulate jobs being in running state (daemon crashed)
      jobsService.markRunning(job1.id)
      jobsService.markRunning(job2.id)

      // Verify jobs are running
      expect(jobsService.getRunningJobs()).toHaveLength(2)
      expect(scheduler.getNextJob()).toBeNull() // No pending jobs

      // Recover crashed jobs
      const recovered = scheduler.recoverCrashedJobs()

      expect(recovered).toBe(2)
      expect(jobsService.getRunningJobs()).toHaveLength(0)

      // Now jobs should be available
      const nextJob = scheduler.getNextJob()
      expect(nextJob).not.toBeNull()
    })
  })

  describe('initializeForStartup with crashed jobs', () => {
    it('recovers crashed jobs during initialization', async () => {
      // Create a chat
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })

      // Create a job and mark it as running (simulating crash)
      const crashedJob = jobsService.create({
        chat_id: 100,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      jobsService.markRunning(crashedJob.id)

      // Verify job is stuck in running state
      expect(jobsService.getById(crashedJob.id)?.status).toBe(
        SyncJobStatus.Running,
      )

      // Initialize scheduler (should recover crashed job first)
      await scheduler.initializeForStartup()

      // Verify crashed job was recovered
      const recoveredJob = jobsService.getById(crashedJob.id)
      expect(recoveredJob?.status).toBe(SyncJobStatus.Pending)
      expect(recoveredJob?.error_message).toBe(
        'Daemon crashed during execution',
      )
    })
  })
})
