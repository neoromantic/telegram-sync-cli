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
      // The chat's tier is the job's priority inside the catch-up lane
      expect(jobs[0]!.priority).toBe(SyncPriority.High)
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

  describe('queue methods', () => {
    it('create no job for a disabled chat or a chat without sync state', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
        forward_cursor: 10,
        backward_cursor: 5,
      })

      for (const chatId of [100, 999]) {
        scheduler.queueForwardCatchup(chatId)
        scheduler.queueInitialLoad(chatId)
        scheduler.queueBackwardHistory(chatId)
      }

      expect(jobsService.getJobsForChat(100)).toHaveLength(0)
      expect(jobsService.getJobsForChat(999)).toHaveLength(0)
    })

    it('give each job its chat tier as priority', () => {
      chatSyncState.upsert({
        chat_id: -4001,
        chat_type: 'group',
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        forward_cursor: 10,
        backward_cursor: 5,
      })
      chatSyncState.upsert({
        chat_id: -4002,
        chat_type: 'group',
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      })

      scheduler.queueForwardCatchup(-4001)
      scheduler.queueBackwardHistory(-4001)
      scheduler.queueInitialLoad(-4002)

      const priorities = jobsService.getPendingJobs().map((job) => job.priority)
      expect(priorities).toEqual([
        SyncPriority.Medium,
        SyncPriority.Medium,
        SyncPriority.Medium,
      ])
    })
  })

  describe('queueBackwardHistory', () => {
    it('queues backward history job for a chat with existing backward_cursor', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 600,
        backward_cursor: 500, // Has an existing cursor
      })

      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.BackwardHistory)
      expect(jobs[0]!.priority).toBe(SyncPriority.High)
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
      // A chat whose newest page came from catch-up: a forward cursor and
      // cached messages, but no backward cursor yet
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 1000,
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
        forward_cursor: 600,
        backward_cursor: 500, // Has a valid cursor
      })

      // Queue backward history - should work since we have a cursor
      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs).toHaveLength(1)
      expect(jobs[0]!.job_type).toBe(SyncJobType.BackwardHistory)
    })

    it('queues the first page instead for a chat without a forward cursor', () => {
      chatSyncState.upsert({
        chat_id: 100,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
      })
      // A live message is cached, but the chat has no first page yet
      messagesCache.upsert({
        chat_id: 100,
        message_id: 1000,
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      scheduler.queueBackwardHistory(100)

      const jobs = jobsService.getJobsForChat(100)
      expect(jobs.map((job) => job.job_type)).toEqual([SyncJobType.InitialLoad])
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

    it('queues initial load for a chat whose first messages arrived live', async () => {
      // Live updates cached and counted messages, but set no cursor
      chatSyncState.incrementSyncedMessages(1, 5)
      messagesCache.upsert({
        chat_id: 1,
        message_id: 100,
        message_type: 'text',
        date: Date.now(),
        raw_json: '{}',
      })

      await scheduler.initializeForStartup()

      const initialLoadJobs = jobsService
        .getJobsForChat(1)
        .filter((j) => j.job_type === SyncJobType.InitialLoad)
      expect(initialLoadJobs).toHaveLength(1)
    })

    it('queues initial load for a chat with complete history but no cursor', async () => {
      // An empty chat from an older version: history complete, no cursor
      chatSyncState.markHistoryComplete(1)

      await scheduler.initializeForStartup()

      const initialLoadJobs = jobsService
        .getJobsForChat(1)
        .filter((j) => j.job_type === SyncJobType.InitialLoad)
      expect(initialLoadJobs).toHaveLength(1)
    })

    it('does not queue initial load for chats with a forward cursor', async () => {
      chatSyncState.updateCursors(1, {
        forward_cursor: 100,
        backward_cursor: 1,
      })
      chatSyncState.incrementSyncedMessages(1, 100)

      await scheduler.initializeForStartup()

      const initialLoadJobs = jobsService
        .getJobsForChat(1)
        .filter((j) => j.job_type === SyncJobType.InitialLoad)
      expect(initialLoadJobs).toHaveLength(0)
    })
  })

  describe('refreshQueues', () => {
    function seed(
      chatId: number,
      options: {
        enabled?: boolean
        cursor?: number
        top?: number | null
        historyComplete?: boolean
      } = {},
    ) {
      chatSyncState.upsert({
        chat_id: chatId,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: options.enabled ?? true,
        forward_cursor: options.cursor,
        backward_cursor: options.cursor === undefined ? undefined : 1,
      })
      if (options.historyComplete ?? true) {
        chatSyncState.markHistoryComplete(chatId)
      }
      if (options.top !== undefined && options.top !== null) {
        chatSyncState.raiseTopMessageId(chatId, options.top)
      }
    }

    const jobsOf = (chatId: number, jobType: SyncJobType) =>
      jobsService.getJobsForChat(chatId).filter((j) => j.job_type === jobType)

    it('queues no catch-up for a chat that is caught up', () => {
      seed(1, { cursor: 1000, top: 1000 })
      seed(2, { cursor: 1000, top: 900 })

      for (let i = 0; i < 10; i++) scheduler.refreshQueues()

      expect(jobsService.getJobsForChat(1)).toHaveLength(0)
      expect(jobsService.getJobsForChat(2)).toHaveLength(0)
    })

    it('queues one catch-up for a chat that is behind', () => {
      seed(1, { cursor: 1000, top: 1150 })
      seed(2, { cursor: 1000, top: null })

      for (let i = 0; i < 10; i++) scheduler.refreshQueues()

      expect(jobsOf(1, SyncJobType.ForwardCatchup)).toHaveLength(1)
      expect(jobsOf(2, SyncJobType.ForwardCatchup)).toHaveLength(1)
      expect(jobsService.getPendingJobs()).toHaveLength(2)
    })

    it('queues no catch-up for a disabled chat or a chat without a cursor', () => {
      seed(1, { enabled: false, cursor: 1000, top: 1150 })
      seed(2, { top: 1150 })

      scheduler.refreshQueues()

      expect(jobsService.getJobsForChat(1)).toHaveLength(0)
      expect(jobsOf(2, SyncJobType.ForwardCatchup)).toHaveLength(0)
    })

    it('queues history for any enabled tier once the chat has a cursor', () => {
      seed(1, { cursor: 1000, top: 1000, historyComplete: false })
      chatSyncState.upsert({
        chat_id: -4001,
        chat_type: 'group',
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
        forward_cursor: 300,
        backward_cursor: 201,
      })
      chatSyncState.raiseTopMessageId(-4001, 300)
      // Turned on by hand: a channel in the Low tier
      chatSyncState.upsert({
        chat_id: -1001234567890,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: true,
        forward_cursor: 900,
        backward_cursor: 801,
      })
      chatSyncState.raiseTopMessageId(-1001234567890, 900)
      seed(2, { enabled: false, cursor: 50, top: 50, historyComplete: false })
      seed(3, { historyComplete: false })

      for (let i = 0; i < 3; i++) scheduler.refreshQueues()

      const history = jobsService
        .getPendingJobs()
        .filter((job) => job.job_type === SyncJobType.BackwardHistory)
        .map((job) => job.chat_id)
        .sort((a, b) => a - b)
      expect(history).toEqual([-1001234567890, -4001, 1])
      // No history before the first page
      expect(jobsOf(3, SyncJobType.BackwardHistory)).toHaveLength(0)
      expect(jobsOf(3, SyncJobType.InitialLoad)).toHaveLength(1)
    })

    it('queues no history for a chat with complete history', () => {
      seed(1, { cursor: 1000, top: 1000 })

      scheduler.refreshQueues()

      expect(jobsService.getJobsForChat(1)).toHaveLength(0)
    })

    it('queues the first page for an enabled chat without a cursor', () => {
      seed(1, { historyComplete: false })
      chatSyncState.incrementSyncedMessages(1, 3)
      seed(2, { enabled: false, historyComplete: false })

      scheduler.refreshQueues()
      scheduler.refreshQueues()

      expect(jobsOf(1, SyncJobType.InitialLoad)).toHaveLength(1)
      expect(jobsService.getJobsForChat(2)).toHaveLength(0)
    })
  })

  describe('lanes', () => {
    const laneOf = (jobType: string) =>
      jobType === SyncJobType.ForwardCatchup
        ? 'catchup'
        : jobType === SyncJobType.InitialLoad
          ? 'firstPage'
          : 'history'

    function queue(jobType: SyncJobType, count: number, priority = 1) {
      for (let i = 0; i < count; i++) {
        jobsService.create({
          chat_id: 1000 + i,
          job_type: jobType,
          priority,
        })
      }
    }

    /** Take `count` jobs the way processJobs does: peek, run, record */
    function run(count: number): string[] {
      const lanes: string[] = []
      for (let i = 0; i < count; i++) {
        const job = scheduler.getNextJob()
        if (!job) break
        jobsService.markRunning(job.id)
        jobsService.markCompleted(job.id)
        scheduler.recordJobRun(job)
        lanes.push(laneOf(job.job_type))
      }
      return lanes
    }

    it('take turns: catch-up, first page, catch-up, history', () => {
      queue(SyncJobType.ForwardCatchup, 10)
      queue(SyncJobType.InitialLoad, 10)
      queue(SyncJobType.BackwardHistory, 5)
      queue(SyncJobType.FullSync, 5)

      expect(run(8)).toEqual([
        'catchup',
        'firstPage',
        'catchup',
        'history',
        'catchup',
        'firstPage',
        'catchup',
        'history',
      ])
    })

    it('give an empty lane slot to the first lane with work', () => {
      queue(SyncJobType.InitialLoad, 10)
      queue(SyncJobType.BackwardHistory, 10)
      // No catch-up: its slots go to first pages
      expect(run(4)).toEqual(['firstPage', 'firstPage', 'firstPage', 'history'])

      jobsService.deletePendingOfType(SyncJobType.InitialLoad)
      queue(SyncJobType.ForwardCatchup, 10)
      // No first pages: their slot goes to catch-up
      expect(run(4)).toEqual(['catchup', 'catchup', 'catchup', 'history'])

      jobsService.deletePendingOfType(SyncJobType.ForwardCatchup)
      expect(run(3)).toEqual(['history', 'history', 'history'])
    })

    it('only move to the next slot when a job ran', () => {
      queue(SyncJobType.ForwardCatchup, 2)
      queue(SyncJobType.InitialLoad, 2)

      const first = scheduler.getNextJob()
      expect(scheduler.getNextJob()).toEqual(first)
      expect(first?.job_type).toBe(SyncJobType.ForwardCatchup)

      scheduler.recordJobRun(first!)
      // The catch-up job is still pending, but it is the first page's turn
      expect(scheduler.getNextJob()?.job_type).toBe(SyncJobType.InitialLoad)
    })

    it('run jobs inside a lane by priority, then age, then id', () => {
      const realNow = Date.now
      try {
        Date.now = () => 1_700_000_000_000
        const medium = jobsService.create({
          chat_id: 1,
          job_type: SyncJobType.BackwardHistory,
          priority: SyncPriority.Medium,
        })
        const high1 = jobsService.create({
          chat_id: 2,
          job_type: SyncJobType.BackwardHistory,
          priority: SyncPriority.High,
        })
        const high2 = jobsService.create({
          chat_id: 3,
          job_type: SyncJobType.FullSync,
          priority: SyncPriority.High,
        })
        Date.now = () => 1_699_999_999_000
        const older = jobsService.create({
          chat_id: 4,
          job_type: SyncJobType.BackwardHistory,
          priority: SyncPriority.High,
        })

        const order: number[] = []
        for (let i = 0; i < 4; i++) {
          const job = jobsService.getNextPendingOfTypes([
            SyncJobType.BackwardHistory,
            SyncJobType.FullSync,
          ])!
          order.push(job.id)
          jobsService.markRunning(job.id)
        }
        expect(order).toEqual([older.id, high1.id, high2.id, medium.id])
      } finally {
        Date.now = realNow
      }
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

  describe('initializeForStartup with old pending jobs', () => {
    it('drops pending catch-ups and queues them only where due', async () => {
      // 0.1.4 left a pending catch-up for every enabled chat
      for (const chatId of [1, 2]) {
        chatSyncState.upsert({
          chat_id: chatId,
          chat_type: 'private',
          sync_priority: SyncPriority.High,
          sync_enabled: true,
          forward_cursor: 1000,
          backward_cursor: 1,
        })
        chatSyncState.markHistoryComplete(chatId)
        jobsService.create({
          chat_id: chatId,
          job_type: SyncJobType.ForwardCatchup,
          priority: SyncPriority.Realtime,
        })
      }
      chatSyncState.raiseTopMessageId(1, 1000)
      chatSyncState.raiseTopMessageId(2, 1150)

      await scheduler.initializeForStartup()

      expect(jobsService.getJobsForChat(1)).toHaveLength(0)
      const pending = jobsService.getPendingJobs()
      expect(pending).toHaveLength(1)
      expect(pending[0]).toMatchObject({
        chat_id: 2,
        job_type: SyncJobType.ForwardCatchup,
      })
    })
  })

  describe('initializeForStartup with pending jobs of other chats', () => {
    it('drops jobs of disabled chats and aligns the rest to their tier', async () => {
      chatSyncState.upsert({
        chat_id: 1,
        chat_type: 'private',
        sync_priority: SyncPriority.High,
        sync_enabled: true,
        forward_cursor: 100,
        backward_cursor: 50,
      })
      chatSyncState.raiseTopMessageId(1, 100)
      chatSyncState.upsert({
        chat_id: -4001,
        chat_type: 'group',
        member_count: 50,
        sync_priority: SyncPriority.Medium,
        sync_enabled: true,
      })
      chatSyncState.upsert({
        chat_id: -1001234567890,
        chat_type: 'channel',
        sync_priority: SyncPriority.Low,
        sync_enabled: false,
        forward_cursor: 10,
      })
      // Jobs queued by an older version
      const history = jobsService.create({
        chat_id: 1,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      const firstPage = jobsService.create({
        chat_id: -4001,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      })
      jobsService.create({
        chat_id: -1001234567890,
        job_type: SyncJobType.BackwardHistory,
        priority: SyncPriority.Background,
      })
      jobsService.create({
        chat_id: 777,
        job_type: SyncJobType.InitialLoad,
        priority: SyncPriority.High,
      })

      await scheduler.initializeForStartup()

      const pending = jobsService.getPendingJobs()
      expect(
        pending.map((job) => [job.id, job.chat_id, job.priority]).sort(),
      ).toEqual(
        [
          [history.id, 1, SyncPriority.High],
          [firstPage.id, -4001, SyncPriority.Medium],
        ].sort(),
      )
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
