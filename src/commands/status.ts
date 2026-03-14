/**
 * Status command - comprehensive system status display
 *
 * Shows daemon status, sync jobs, rate limits, and account info
 * with colorful, easy-to-read output.
 */

import { join } from 'node:path'
import { defineCommand } from 'citty'
import { createPidFile } from '../daemon'
import { accountsDb, getCacheDb, getDataDir } from '../db'
import { createDaemonStatusService } from '../db/daemon-status'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import { getOutputFormat, success } from '../utils/output'
import { printPrettyStatus } from './status/pretty'

/**
 * Get process memory usage (if available)
 */
async function getProcessMemory(pid: number): Promise<number | null> {
  try {
    // Try to read /proc on Linux
    const procFile = Bun.file(`/proc/${pid}/status`)
    if (await procFile.exists()) {
      const content = await procFile.text()
      const match = content.match(/VmRSS:\s+(\d+)\s+kB/)
      if (match?.[1]) {
        return parseInt(match[1], 10) * 1024 // Convert to bytes
      }
    }
  } catch {
    // /proc not available (macOS, etc.)
  }

  try {
    // Try ps command as fallback
    const proc = Bun.spawn(['ps', '-o', 'rss=', '-p', pid.toString()], {
      stdout: 'pipe',
    })
    const output = await new Response(proc.stdout).text()
    const rss = parseInt(output.trim(), 10)
    if (!Number.isNaN(rss)) {
      return rss * 1024 // ps reports in KB
    }
  } catch {
    // ps failed
  }

  return null
}

/**
 * Status command implementation
 */
export const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show comprehensive system status',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Force JSON output',
      alias: 'j',
      default: false,
    },
  },
  async run({ args }) {
    const dataDir = getDataDir()
    const pidPath = join(dataDir, 'daemon.pid')
    const pidFile = createPidFile(pidPath)

    // Collect all status data
    const statusData = await collectStatus(pidFile)

    // Determine output format
    const format = getOutputFormat()
    const useJson = args.json || format === 'json'

    if (useJson) {
      success(statusData)
      return
    }

    // Pretty print with colors
    printPrettyStatus(statusData)
  },
})

/**
 * Collect all status information
 */
export async function collectStatus(
  pidFile: ReturnType<typeof createPidFile>,
) {
  const pid = pidFile.read()
  const isRunning = pid !== null && pidFile.isRunning()

  // Daemon status
  const daemonStatus: {
    status: 'running' | 'stopped'
    pid: number | null
    uptime_seconds: number | null
    memory_bytes: number | null
    started_at: string | null
    last_update: string | null
    connected_accounts: number
    total_accounts: number
    messages_synced: number
  } = {
    status: isRunning ? 'running' : 'stopped',
    pid: isRunning ? pid : null,
    uptime_seconds: null,
    memory_bytes: null,
    started_at: null,
    last_update: null,
    connected_accounts: 0,
    total_accounts: 0,
    messages_synced: 0,
  }

  // Sync status
  const syncStatus: {
    pending_jobs: number
    running_jobs: number
    failed_jobs: number
    jobs: Array<{
      id: number
      chat_id: number
      type: string
      status: string
      messages_fetched: number
    }>
  } = {
    pending_jobs: 0,
    running_jobs: 0,
    failed_jobs: 0,
    jobs: [],
  }

  // Rate limits status
  const rateLimitsStatus: {
    api_calls_last_minute: number
    calls_by_method: Record<string, number>
    active_flood_waits: Array<{
      method: string
      blocked_until: string
      wait_seconds: number
      remaining_seconds: number
    }>
  } = {
    api_calls_last_minute: 0,
    calls_by_method: {},
    active_flood_waits: [],
  }

  const progressStatus: {
    chats_total: number
    chats_enabled: number
    chats_history_complete: number
    chats_history_pending: number
    chats_cached: number
    messages_tracked: number
    messages_cached: number
    sample_chats: Array<{
      chat_id: number
      chat_type: string
      synced_messages: number
      history_complete: boolean
      forward_cursor: number | null
      backward_cursor: number | null
      sync_priority: number
    }>
  } = {
    chats_total: 0,
    chats_enabled: 0,
    chats_history_complete: 0,
    chats_history_pending: 0,
    chats_cached: 0,
    messages_tracked: 0,
    messages_cached: 0,
    sample_chats: [],
  }

  // Try to read from database
  try {
    const cacheDb = getCacheDb()

    // Daemon info
    const daemonService = createDaemonStatusService(cacheDb)
    const daemonInfo = daemonService.getDaemonInfo()

    if (isRunning && daemonInfo.startedAt) {
      daemonStatus.uptime_seconds = Math.floor(
        (Date.now() - daemonInfo.startedAt) / 1000,
      )
      daemonStatus.started_at = new Date(daemonInfo.startedAt).toISOString()
    }
    if (daemonInfo.lastUpdate) {
      daemonStatus.last_update = new Date(daemonInfo.lastUpdate).toISOString()
    }
    daemonStatus.connected_accounts = daemonInfo.connectedAccounts
    daemonStatus.total_accounts = daemonInfo.totalAccounts
    daemonStatus.messages_synced = daemonInfo.messagesSynced

    // Get memory usage
    if (isRunning && pid) {
      const memory = await getProcessMemory(pid)
      if (memory) {
        daemonStatus.memory_bytes = memory
      }
    }

    // Sync jobs
    const syncService = createSyncJobsService(cacheDb)
    const pendingJobs = syncService.getPendingJobs()
    const runningJobs = syncService.getRunningJobs()

    syncStatus.pending_jobs = pendingJobs.length
    syncStatus.running_jobs = runningJobs.length

    // Get recent jobs for display
    const recentJobs = [...runningJobs, ...pendingJobs.slice(0, 5)]
    syncStatus.jobs = recentJobs.map((job) => ({
      id: job.id,
      chat_id: job.chat_id,
      type: job.job_type,
      status: job.status,
      messages_fetched: job.messages_fetched,
    }))

    // Rate limits
    const rateLimitsService = createRateLimitsService(cacheDb)
    const rlStatus = rateLimitsService.getStatus()

    rateLimitsStatus.api_calls_last_minute = rlStatus.totalCalls
    rateLimitsStatus.calls_by_method = rlStatus.callsByMethod

    const now = Math.floor(Date.now() / 1000)
    rateLimitsStatus.active_flood_waits = rlStatus.activeFloodWaits.map(
      (fw) => ({
        method: fw.method,
        blocked_until: new Date(fw.blockedUntil * 1000).toISOString(),
        wait_seconds: fw.waitSeconds,
        remaining_seconds: Math.max(0, fw.blockedUntil - now),
      }),
    )

    const totalChatsRow = cacheDb
      .query('SELECT COUNT(*) as count FROM chat_sync_state')
      .get() as { count: number } | null
    const enabledChatsRow = cacheDb
      .query(
        'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1',
      )
      .get() as { count: number } | null
    const completeChatsRow = cacheDb
      .query(
        'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1 AND history_complete = 1',
      )
      .get() as { count: number } | null
    const pendingChatsRow = cacheDb
      .query(
        'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1 AND history_complete = 0',
      )
      .get() as { count: number } | null
    const chatsCachedRow = cacheDb
      .query('SELECT COUNT(*) as count FROM chats_cache')
      .get() as { count: number } | null
    const messagesTrackedRow = cacheDb
      .query(
        'SELECT COALESCE(SUM(synced_messages), 0) as count FROM chat_sync_state',
      )
      .get() as { count: number } | null
    const messagesCachedRow = cacheDb
      .query('SELECT COUNT(*) as count FROM messages_cache')
      .get() as { count: number } | null
    const sampleChatsRows = cacheDb
      .query(
        `SELECT chat_id, chat_type, synced_messages, history_complete, forward_cursor, backward_cursor, sync_priority
         FROM chat_sync_state
         WHERE sync_enabled = 1
         ORDER BY history_complete ASC, synced_messages DESC
         LIMIT 5`,
      )
      .all() as Array<{
      chat_id: number
      chat_type: string
      synced_messages: number
      history_complete: number
      forward_cursor: number | null
      backward_cursor: number | null
      sync_priority: number
    }>

    progressStatus.chats_total = totalChatsRow?.count ?? 0
    progressStatus.chats_enabled = enabledChatsRow?.count ?? 0
    progressStatus.chats_history_complete = completeChatsRow?.count ?? 0
    progressStatus.chats_history_pending = pendingChatsRow?.count ?? 0
    progressStatus.chats_cached = chatsCachedRow?.count ?? 0
    progressStatus.messages_tracked = messagesTrackedRow?.count ?? 0
    progressStatus.messages_cached = messagesCachedRow?.count ?? 0
    progressStatus.sample_chats = sampleChatsRows.map((row) => ({
      chat_id: row.chat_id,
      chat_type: row.chat_type,
      synced_messages: row.synced_messages,
      history_complete: row.history_complete === 1,
      forward_cursor: row.forward_cursor,
      backward_cursor: row.backward_cursor,
      sync_priority: row.sync_priority,
    }))
  } catch {
    // Database might not be initialized
  }

  // Account info
  const accounts = accountsDb.getAll()
  const activeAccount = accountsDb.getActive()

  const accountsStatus = {
    total: accounts.length,
    active_id: activeAccount?.id ?? null,
    active_phone: activeAccount?.phone ?? null,
    active_name: activeAccount?.name ?? null,
    active_username: activeAccount?.username ?? null,
    active_label: activeAccount?.label ?? null,
    accounts: accounts.map((a) => ({
      id: a.id,
      phone: a.phone,
      name: a.name,
      username: a.username,
      label: a.label,
      is_active: a.is_active === 1,
    })),
  }

  return {
    daemon: daemonStatus,
    sync: syncStatus,
    progress: progressStatus,
    rate_limits: rateLimitsStatus,
    accounts: accountsStatus,
    timestamp: new Date().toISOString(),
  }
}

/**
 * Print status in a pretty, colored format
 */
