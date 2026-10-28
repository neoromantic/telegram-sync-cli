/**
 * Status command - comprehensive system status display
 *
 * Shows daemon status, sync jobs, rate limits, and account info
 * with colorful, easy-to-read output.
 */

import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { createPidFile } from '../daemon'
import {
  accountsDb,
  ensureCacheLayout,
  getDataDir,
  getLegacyCachePath,
  isCacheUnavailableError,
  listSharedCaches,
  openExistingAccountCacheDb,
} from '../db'
import { accountMediaPath } from '../db/cache-layout'
import { type CacheSize, readCacheSize } from '../db/cache-maintenance'
import { createChatSyncStateService } from '../db/chat-sync-state'
import {
  createDaemonStatusService,
  type DaemonInfo,
  summarizeDaemonStatus,
} from '../db/daemon-status'
import { createRateLimitsService } from '../db/rate-limits'
import { createSyncJobsService } from '../db/sync-jobs'
import type { SyncMode } from '../db/sync-schema'
import { cacheUnavailableSuggestion } from '../utils/account-cache'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../utils/account-selector'
import { type MediaUsage, readMediaUsage } from '../utils/media-cache'
import { getOutputFormat, success } from '../utils/output'
import { VERSION } from '../version'
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
    account: {
      type: 'string',
      description: `${ACCOUNT_SELECTOR_DESCRIPTION}; report only this account (default: all)`,
    },
    sizes: {
      type: 'boolean',
      description:
        "Add each table's size and the media cache's (reads every page of the cache and lists every cached file, so slower)",
      default: false,
    },
  },
  async run({ args }) {
    const dataDir = getDataDir()
    const pidPath = join(dataDir, 'daemon.pid')
    const pidFile = createPidFile(pidPath)
    const accountId = resolveAccountSelector(args.account)

    // Collect all status data
    const statusData = await collectStatus(pidFile, {
      accountId,
      sizes: args.sizes,
    })

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

/** A listed sync job, with the account whose cache holds it */
export interface StatusJob {
  account_id: number
  id: number
  chat_id: number
  type: string
  status: string
  messages_fetched: number
  /** Failed tries so far */
  attempts: number
  /** The last error */
  error: string | null
  /** When a waiting job runs again (ISO); null if it is due */
  next_run_at: string | null
  /** The chat's sync mode; null if the chat has no sync state */
  sync_mode: SyncMode | null
}

export interface StatusSampleChat {
  account_id: number
  chat_id: number
  chat_type: string
  synced_messages: number
  history_complete: boolean
  forward_cursor: number | null
  backward_cursor: number | null
  sync_priority: number
}

export interface StatusFloodWait {
  account_id: number
  method: string
  blocked_until: string
  wait_seconds: number
  remaining_seconds: number
}

/** What one account's cache says */
export interface AccountStatusSnapshot {
  accountId: number
  cache: {
    status: 'ok' | 'missing' | 'error'
    error?: string
    /** The cache's size; null for a missing cache or one that failed */
    size: CacheSize | null
  }
  /** The media cache's size; only with --sizes, else null */
  media: MediaUsage | null
  daemon: DaemonInfo | null
  sync: {
    pending_jobs: number
    running_jobs: number
    failed_jobs: number
    retrying_jobs: number
    running: StatusJob[]
    pending: StatusJob[]
    failed: StatusJob[]
  }
  progress: {
    chats_total: number
    chats_enabled: number
    chats_history_complete: number
    chats_history_pending: number
    chats_cached: number
    messages_tracked: number
    messages_cached: number
    sample_chats: StatusSampleChat[]
  }
  rate_limits: {
    api_calls_last_minute: number
    calls_by_method: Record<string, number>
    active_flood_waits: StatusFloodWait[]
  }
}

function emptyAccountSnapshot(accountId: number): AccountStatusSnapshot {
  return {
    accountId,
    cache: { status: 'missing', size: null },
    media: null,
    daemon: null,
    sync: {
      pending_jobs: 0,
      running_jobs: 0,
      failed_jobs: 0,
      retrying_jobs: 0,
      running: [],
      pending: [],
      failed: [],
    },
    progress: {
      chats_total: 0,
      chats_enabled: 0,
      chats_history_complete: 0,
      chats_history_pending: 0,
      chats_cached: 0,
      messages_tracked: 0,
      messages_cached: 0,
      sample_chats: [],
    },
    rate_limits: {
      api_calls_last_minute: 0,
      calls_by_method: {},
      active_flood_waits: [],
    },
  }
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { count: number } | null)?.count ?? 0
}

/** An account whose cache can't be read: zeroed figures and the error */
function failedAccountSnapshot(
  accountId: number,
  err: unknown,
): AccountStatusSnapshot {
  return {
    ...emptyAccountSnapshot(accountId),
    cache: {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      size: null,
    },
  }
}

/**
 * Read one account's cache. An account without a cache file reads as
 * empty, and none is created. A cache that fails to open or to answer a
 * query (a corrupt page, say) reads as `error` with zeroed figures, so the
 * other accounts and the daemon section still report.
 */
export function readAccountStatus(
  accountId: number,
  options: { sizes?: boolean } = {},
): AccountStatusSnapshot {
  let cacheDb: Database | null
  try {
    cacheDb = openExistingAccountCacheDb(accountId)
  } catch (err) {
    return failedAccountSnapshot(accountId, err)
  }
  if (!cacheDb) return emptyAccountSnapshot(accountId)

  try {
    return readOpenAccountStatus(accountId, cacheDb, options.sizes ?? false)
  } catch (err) {
    return failedAccountSnapshot(accountId, err)
  }
}

function readOpenAccountStatus(
  accountId: number,
  cacheDb: Database,
  sizes: boolean,
): AccountStatusSnapshot {
  const snapshot = emptyAccountSnapshot(accountId)
  snapshot.cache = {
    status: 'ok',
    size: readCacheSize(cacheDb, cacheDb.filename, { tables: sizes }),
  }

  snapshot.daemon = createDaemonStatusService(cacheDb).getDaemonInfo()

  // Sync jobs
  const syncService = createSyncJobsService(cacheDb)
  const counts = syncService.countJobs()
  snapshot.sync.pending_jobs = counts.pending
  snapshot.sync.running_jobs = counts.running
  snapshot.sync.failed_jobs = counts.failed
  snapshot.sync.retrying_jobs = counts.retrying

  const chatSyncState = createChatSyncStateService(cacheDb)
  const nowMs = Date.now()
  const toStatusJob = (
    job: ReturnType<typeof syncService.getPendingJobs>[number],
  ): StatusJob => ({
    account_id: accountId,
    id: job.id,
    chat_id: job.chat_id,
    type: job.job_type,
    status: job.status,
    messages_fetched: job.messages_fetched,
    attempts: job.attempts,
    error: job.error_message,
    next_run_at:
      job.next_run_at > nowMs ? new Date(job.next_run_at).toISOString() : null,
    sync_mode: chatSyncState.get(job.chat_id)?.sync_mode ?? null,
  })
  // Running jobs, the next pending ones and the newest failed ones
  snapshot.sync.running = syncService.getRunningJobs().map(toStatusJob)
  snapshot.sync.pending = syncService
    .getPendingJobs()
    .slice(0, 5)
    .map(toStatusJob)
  snapshot.sync.failed = syncService.getFailedJobs(5).map(toStatusJob)

  // Rate limits
  const rlStatus = createRateLimitsService(cacheDb).getStatus()
  const now = Math.floor(Date.now() / 1000)
  snapshot.rate_limits = {
    api_calls_last_minute: rlStatus.totalCalls,
    calls_by_method: rlStatus.callsByMethod,
    active_flood_waits: rlStatus.activeFloodWaits.map((fw) => ({
      account_id: accountId,
      method: fw.method,
      blocked_until: new Date(fw.blockedUntil * 1000).toISOString(),
      wait_seconds: fw.waitSeconds,
      remaining_seconds: Math.max(0, fw.blockedUntil - now),
    })),
  }

  // Progress
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

  snapshot.progress = {
    chats_total: count(
      cacheDb,
      'SELECT COUNT(*) as count FROM chat_sync_state',
    ),
    chats_enabled: count(
      cacheDb,
      'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1',
    ),
    chats_history_complete: count(
      cacheDb,
      'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1 AND history_complete = 1',
    ),
    chats_history_pending: count(
      cacheDb,
      'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1 AND history_complete = 0',
    ),
    chats_cached: count(cacheDb, 'SELECT COUNT(*) as count FROM chats_cache'),
    messages_tracked: count(
      cacheDb,
      'SELECT COALESCE(SUM(synced_messages), 0) as count FROM chat_sync_state',
    ),
    messages_cached: count(
      cacheDb,
      'SELECT COUNT(*) as count FROM messages_cache',
    ),
    sample_chats: sampleChatsRows.map((row) => ({
      account_id: accountId,
      chat_id: row.chat_id,
      chat_type: row.chat_type,
      synced_messages: row.synced_messages,
      history_complete: row.history_complete === 1,
      forward_cursor: row.forward_cursor,
      backward_cursor: row.backward_cursor,
      sync_priority: row.sync_priority,
    })),
  }

  return snapshot
}

/** An account's media cache size; null when its folder can't be read */
function readAccountMediaUsage(
  dataDir: string,
  accountId: number,
): MediaUsage | null {
  try {
    return readMediaUsage(accountMediaPath(dataDir, accountId))
  } catch {
    return null
  }
}

/**
 * The shared cache of an older version: set-aside files, and a move that
 * waits for another process. Never fails the command.
 */
export function collectStorageStatus(dataDir: string) {
  let migration: {
    reason: string
    path: string
    suggestion: string
  } | null = null

  try {
    const layout = ensureCacheLayout({ mode: 'report' })
    if (
      (layout.state === 'blocked' || layout.state === 'deferred') &&
      layout.reason
    ) {
      migration = {
        reason: layout.reason,
        path: layout.path ?? getLegacyCachePath(),
        suggestion: cacheUnavailableSuggestion(layout.reason),
      }
    }
  } catch (err) {
    const reason = isCacheUnavailableError(err) ? err.reason : 'move_failed'
    migration = {
      reason,
      path: getLegacyCachePath(),
      suggestion: cacheUnavailableSuggestion(reason),
    }
  }

  let legacyCaches: Array<{ path: string; size_bytes: number }> = []
  try {
    legacyCaches = listSharedCaches(dataDir)
  } catch {
    // An unreadable data dir shows no files
  }

  return { legacy_caches: legacyCaches, migration }
}

/** The live daemon's view of an account, or null without one */
export function liveConnection(
  snapshot: AccountStatusSnapshot,
  livePid: number | null,
): { status: string; last_error: string | null } | null {
  const daemon = snapshot.daemon
  if (
    livePid === null ||
    !daemon ||
    daemon.status !== 'running' ||
    daemon.pid !== livePid
  ) {
    return null
  }
  return {
    status: daemon.connectionStatus ?? 'unknown',
    last_error: daemon.lastError,
  }
}

/** One account's own figures, for its entry under accounts */
function accountBreakdown(
  snapshot: AccountStatusSnapshot,
  livePid: number | null,
) {
  return {
    cache: snapshot.cache,
    media: snapshot.media,
    connection: liveConnection(snapshot, livePid),
    sync: {
      pending_jobs: snapshot.sync.pending_jobs,
      running_jobs: snapshot.sync.running_jobs,
      failed_jobs: snapshot.sync.failed_jobs,
      retrying_jobs: snapshot.sync.retrying_jobs,
    },
    progress: {
      chats_enabled: snapshot.progress.chats_enabled,
      chats_history_complete: snapshot.progress.chats_history_complete,
      chats_history_pending: snapshot.progress.chats_history_pending,
      messages_cached: snapshot.progress.messages_cached,
    },
    rate_limits: {
      api_calls_last_minute: snapshot.rate_limits.api_calls_last_minute,
      active_flood_waits: snapshot.rate_limits.active_flood_waits.length,
    },
  }
}

function sumRecords(records: Array<Record<string, number>>) {
  const total: Record<string, number> = {}
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      total[key] = (total[key] ?? 0) + value
    }
  }
  return total
}

/**
 * Collect all status information: every account's cache read on its own,
 * then the totals over them. With `accountId`, the totals and lists cover
 * only that account; the daemon section still covers the whole daemon.
 */
export async function collectStatus(
  pidFile: ReturnType<typeof createPidFile>,
  options: { dataDir?: string; accountId?: number; sizes?: boolean } = {},
) {
  const dataDir = options.dataDir ?? getDataDir()
  const pid = pidFile.read()
  const isRunning = pid !== null && pidFile.isRunning()
  const livePid = isRunning ? pid : null

  // Moves a shared cache first, so the accounts' files below are current
  const storage = collectStorageStatus(dataDir)

  const allAccounts = accountsDb.getAll()
  const activeAccount = accountsDb.getActive()
  const inScope = (accountId: number) =>
    options.accountId === undefined || accountId === options.accountId
  // dbstat reads the whole file and the media walk stats every file: only
  // for the accounts shown
  const sizesOf = (accountId: number) =>
    (options.sizes ?? false) && inScope(accountId)
  const allSnapshots = allAccounts.map((account) => {
    const snapshot = readAccountStatus(account.id, {
      sizes: sizesOf(account.id),
    })
    if (sizesOf(account.id)) {
      snapshot.media = readAccountMediaUsage(dataDir, account.id)
    }
    return snapshot
  })
  const accounts = allAccounts.filter((account) => inScope(account.id))
  const snapshots = allSnapshots.filter((snapshot) =>
    inScope(snapshot.accountId),
  )
  const snapshotOf = new Map(
    allSnapshots.map((snapshot) => [snapshot.accountId, snapshot]),
  )

  // Daemon: only the rows the live daemon wrote count
  const summary = summarizeDaemonStatus(
    allSnapshots.flatMap((snapshot) =>
      snapshot.daemon ? [snapshot.daemon] : [],
    ),
    livePid,
  )
  // A daemon that holds the PID file but hasn't written its rows yet (its
  // first open after an upgrade can wait for the shared-cache move, and an
  // older tg writes none to accounts/<id>/cache.db) compares nothing
  const daemonWroteRows = isRunning && summary.totalAccounts > 0
  const daemonStatus: {
    status: 'running' | 'stopped'
    pid: number | null
    /** The version the running daemon recorded at start */
    version: string | null
    /** A running daemon of another version, or one that recorded none */
    version_mismatch: boolean
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
    version: daemonWroteRows ? summary.version : null,
    version_mismatch: daemonWroteRows && summary.version !== VERSION,
    uptime_seconds:
      isRunning && summary.startedAt
        ? Math.floor((Date.now() - summary.startedAt) / 1000)
        : null,
    memory_bytes: null,
    started_at:
      isRunning && summary.startedAt
        ? new Date(summary.startedAt).toISOString()
        : null,
    last_update: summary.lastUpdate
      ? new Date(summary.lastUpdate).toISOString()
      : null,
    connected_accounts: summary.connectedAccounts,
    total_accounts: summary.totalAccounts,
    messages_synced: summary.messagesSynced,
  }
  if (isRunning && pid) {
    daemonStatus.memory_bytes = await getProcessMemory(pid)
  }

  // Sync status. pending_jobs includes the jobs waiting for a retry;
  // retrying_jobs counts those that failed at least once. Jobs are listed
  // by account: running ones, the next pending ones, the newest failed ones.
  const sum = (pick: (snapshot: AccountStatusSnapshot) => number) =>
    snapshots.reduce((total, snapshot) => total + pick(snapshot), 0)
  const syncStatus = {
    pending_jobs: sum((s) => s.sync.pending_jobs),
    running_jobs: sum((s) => s.sync.running_jobs),
    failed_jobs: sum((s) => s.sync.failed_jobs),
    retrying_jobs: sum((s) => s.sync.retrying_jobs),
    jobs: [
      ...snapshots.flatMap((s) => s.sync.running),
      ...snapshots.flatMap((s) => s.sync.pending),
      ...snapshots.flatMap((s) => s.sync.failed),
    ],
  }

  const rateLimitsStatus = {
    api_calls_last_minute: sum((s) => s.rate_limits.api_calls_last_minute),
    calls_by_method: sumRecords(
      snapshots.map((s) => s.rate_limits.calls_by_method),
    ),
    active_flood_waits: snapshots.flatMap(
      (s) => s.rate_limits.active_flood_waits,
    ),
  }

  const progressStatus = {
    chats_total: sum((s) => s.progress.chats_total),
    chats_enabled: sum((s) => s.progress.chats_enabled),
    chats_history_complete: sum((s) => s.progress.chats_history_complete),
    chats_history_pending: sum((s) => s.progress.chats_history_pending),
    chats_cached: sum((s) => s.progress.chats_cached),
    messages_tracked: sum((s) => s.progress.messages_tracked),
    messages_cached: sum((s) => s.progress.messages_cached),
    // The overall top 5, ordered like each account's
    sample_chats: snapshots
      .flatMap((s) => s.progress.sample_chats)
      .sort(
        (a, b) =>
          Number(a.history_complete) - Number(b.history_complete) ||
          b.synced_messages - a.synced_messages ||
          a.account_id - b.account_id,
      )
      .slice(0, 5),
  }

  const accountsStatus = {
    total: allAccounts.length,
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
      ...accountBreakdown(snapshotOf.get(a.id)!, livePid),
    })),
  }

  return {
    /** The account the figures cover; null for every account */
    account_id: options.accountId ?? null,
    daemon: daemonStatus,
    sync: syncStatus,
    progress: progressStatus,
    rate_limits: rateLimitsStatus,
    accounts: accountsStatus,
    storage: {
      ...storage,
      /** The files and WALs of the caches in scope */
      cache_bytes: sum((s) =>
        s.cache.size ? s.cache.size.file_bytes + s.cache.size.wal_bytes : 0,
      ),
      /**
       * The media caches in scope, partial downloads included; only with
       * --sizes. Counted apart from the caches: no shared limit.
       */
      media_bytes: options.sizes
        ? sum((s) => (s.media ? s.media.bytes + s.media.partial_bytes : 0))
        : null,
    },
    cli_version: VERSION,
    timestamp: new Date().toISOString(),
  }
}
