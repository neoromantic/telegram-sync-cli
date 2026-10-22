import { SYNC_RETRY_CONFIG } from '../../daemon/sync-retry'
import { UPGRADE_DOCS_URL } from '../../db/cache-layout'
import { SyncJobStatus, type SyncMode } from '../../db/sync-schema'
import { formatBytes, formatRelativeTime } from '../../utils/formatting'
import { formatDuration } from '../../utils/time'
import type { collectStatus } from '../status'
import { c, icons, jobStatusIcon, printHeader, printRow } from './formatters'

export type StatusSnapshot = Awaited<ReturnType<typeof collectStatus>>
type StatusJob = StatusSnapshot['sync']['jobs'][number]

/**
 * With several accounts each listed item says whose cache it is in; with
 * one the output stays as it was
 */
function hasSeveralAccounts(status: StatusSnapshot): boolean {
  return status.accounts.total > 1
}

function accountTag(status: StatusSnapshot, accountId: number): string {
  return hasSeveralAccounts(status) ? ` ${c.dim(`acct:${accountId}`)}` : ''
}

function printDaemonSection(status: StatusSnapshot): void {
  printHeader('Daemon')

  const daemonIcon =
    status.daemon.status === 'running' ? icons.running : icons.stopped
  const daemonColor = status.daemon.status === 'running' ? c.success : c.error
  printRow(
    'Status',
    daemonColor(`${daemonIcon} ${status.daemon.status.toUpperCase()}`),
  )

  if (status.daemon.pid) {
    printRow('PID', c.number(status.daemon.pid))
  }

  const { version, version_mismatch } = status.daemon
  if (version !== null || version_mismatch) {
    printRow(
      'Version',
      version === null
        ? c.warning('not recorded')
        : version_mismatch
          ? c.warning(version)
          : c.value(version),
    )
  }

  if (status.daemon.uptime_seconds !== null) {
    printRow(
      'Uptime',
      c.value(formatDuration(status.daemon.uptime_seconds * 1000)),
    )
  }

  if (status.daemon.memory_bytes !== null) {
    printRow('Memory', c.value(formatBytes(status.daemon.memory_bytes)))
  }

  if (
    status.daemon.connected_accounts > 0 ||
    status.daemon.total_accounts > 0
  ) {
    printRow(
      'Connections',
      `${c.number(status.daemon.connected_accounts)} ${c.dim('/')} ${c.number(status.daemon.total_accounts)} accounts`,
    )
  }

  if (status.daemon.messages_synced > 0) {
    printRow(
      'Messages Synced',
      c.number(status.daemon.messages_synced.toLocaleString()),
    )
  }

  if (status.daemon.last_update) {
    const lastUpdate = new Date(status.daemon.last_update).getTime()
    printRow('Last Update', c.dim(formatRelativeTime(lastUpdate)))
  }

  if (version_mismatch) printDaemonVersionHint(version, status.cli_version)
}

/** Whether a version is newer than another; an invalid one counts as older */
function isNewerVersion(version: string, than: string): boolean {
  try {
    return Bun.semver.order(version, than) > 0
  } catch {
    return false
  }
}

/**
 * Say what to do about a running daemon of another version. Restarting a
 * newer daemon with this tg would downgrade it, so then use the newer tg.
 */
function printDaemonVersionHint(
  version: string | null,
  cliVersion: string,
): void {
  console.log()
  if (version !== null && isNewerVersion(version, cliVersion)) {
    console.log(
      c.warning(
        `  ${icons.warning} The daemon runs ${version}, newer than this tg (${cliVersion}). Use the newer tg; restarting the daemon with this one would downgrade it.`,
      ),
    )
    return
  }

  const runs =
    version === null
      ? 'The daemon was started by an older tg.'
      : `The daemon runs ${version}, this tg is ${cliVersion}.`
  console.log(
    c.warning(
      `  ${icons.warning} ${runs} Restart the daemon to run ${cliVersion}:`,
    ),
  )
  console.log(`    ${c.value('tg daemon stop')}`)
  console.log(`    ${c.value('tg daemon start')}`)
}

/** What a failed job or one waiting to run again is waiting for */
function jobRetryDetail(job: StatusJob): string {
  const error = job.error ? `: ${job.error}` : ''

  if (job.status === SyncJobStatus.Failed) {
    const tries =
      job.attempts > 0
        ? ` after ${job.attempts} attempt${job.attempts === 1 ? '' : 's'}`
        : ''
    return c.red(` failed${tries}${error}`)
  }
  if (job.status !== SyncJobStatus.Pending) return ''

  const next = job.next_run_at
    ? `next in ${formatDuration(Math.max(0, Date.parse(job.next_run_at) - Date.now()))}`
    : null
  if (job.attempts > 0) {
    const attempt = `attempt ${job.attempts} of ${SYNC_RETRY_CONFIG.maxAttempts}`
    return c.yellow(` ${[attempt, next].filter(Boolean).join(', ')}${error}`)
  }
  return next ? c.dim(` ${next}`) : ''
}

/**
 * The tg chats sync command that deletes a chat's failed jobs and keeps its
 * mode: without a flag the command turns the chat on. With several accounts
 * it names the account whose cache holds the job.
 */
function retrySyncCommand(
  chatId: number,
  mode: SyncMode | null,
  accountId: number | null,
): string {
  const flag = mode === 'on' ? '' : mode === 'off' ? ' --off' : ' --auto'
  const account = accountId === null ? '' : ` --account ${accountId}`
  return `tg chats sync ${chatId}${flag}${account}`
}

function printSyncJobsSection(status: StatusSnapshot): void {
  printHeader('Sync Jobs')

  const { pending_jobs, running_jobs, failed_jobs, retrying_jobs } = status.sync
  if (pending_jobs + running_jobs + failed_jobs === 0) {
    printRow('Queue', c.dim('Empty'))
    return
  }

  if (running_jobs > 0) {
    printRow('Running', c.success(`${running_jobs} jobs`))
  }
  if (pending_jobs > 0) {
    printRow('Pending', c.warning(`${pending_jobs} jobs`))
  }
  if (retrying_jobs > 0) {
    printRow('Retrying', c.yellow(`${retrying_jobs} jobs`))
  }
  if (failed_jobs > 0) {
    printRow('Failed', c.red(`${failed_jobs} jobs`))
  }

  if (status.sync.jobs.length > 0) {
    console.log()
    for (const job of status.sync.jobs) {
      const statusIcon = jobStatusIcon(job.status as SyncJobStatus)
      const fetched =
        job.messages_fetched > 0 ? c.dim(` (${job.messages_fetched} msgs)`) : ''
      console.log(
        `    ${statusIcon} ${c.cyan(`#${job.id}`)} ${c.value(job.type)} ${c.dim(`chat:${job.chat_id}`)}${accountTag(status, job.account_id)}${fetched}${jobRetryDetail(job)}`,
      )
    }
  }

  if (failed_jobs > 0) {
    console.log()
    console.log(
      c.dim('  Failed jobs are retried after 24 h or a daemon restart.'),
    )
    const commands = new Set(
      status.sync.jobs
        .filter((job) => job.status === SyncJobStatus.Failed)
        .map((job) =>
          retrySyncCommand(
            job.chat_id,
            job.sync_mode,
            hasSeveralAccounts(status) ? job.account_id : null,
          ),
        ),
    )
    if (commands.size > 0) {
      console.log(
        c.dim(
          "  To retry at the daemon's next refresh, keeping the chat's mode:",
        ),
      )
      for (const command of commands) console.log(`    ${c.value(command)}`)
    }
  }
}

function printSyncProgressSection(status: StatusSnapshot): void {
  printHeader('Sync Progress')

  printRow('Chats Tracked', c.number(status.progress.chats_total))
  printRow('Chats Enabled', c.number(status.progress.chats_enabled))

  if (status.progress.chats_enabled > 0) {
    printRow(
      'History Complete',
      `${c.number(status.progress.chats_history_complete)} ${c.dim('/')} ${c.number(status.progress.chats_enabled)}`,
    )
  } else {
    printRow('History Complete', c.dim('0'))
  }

  printRow(
    'Messages Tracked',
    c.number(status.progress.messages_tracked.toLocaleString()),
  )
  printRow(
    'Messages Cached',
    c.number(status.progress.messages_cached.toLocaleString()),
  )

  if (status.progress.chats_cached > 0) {
    printRow('Chats Cached', c.number(status.progress.chats_cached))
  }

  if (status.progress.sample_chats.length > 0) {
    console.log()
    console.log(c.label('  Sample Chats:'))
    for (const chat of status.progress.sample_chats) {
      const state = chat.history_complete
        ? c.success('complete')
        : c.warning('backfill')
      const synced = c.number(chat.synced_messages.toLocaleString())
      console.log(
        `    ${c.dim(icons.bullet)} ${c.value(chat.chat_type)} ${c.dim(`chat:${chat.chat_id}`)}${accountTag(status, chat.account_id)} ${c.dim(icons.arrow)} ${synced} msgs ${c.dim(icons.arrow)} ${state}`,
      )
    }
  }
}

function printRateLimitsSection(status: StatusSnapshot): void {
  printHeader('Rate Limits')
  printRow('API Calls (1m)', c.number(status.rate_limits.api_calls_last_minute))

  const methodEntries = Object.entries(status.rate_limits.calls_by_method)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  if (methodEntries.length > 0) {
    console.log()
    console.log(c.label('  Top Methods:'))
    for (const [method, count] of methodEntries) {
      const shortMethod = method.split('.').pop() ?? method
      console.log(
        `    ${c.dim(icons.bullet)} ${c.value(shortMethod)} ${c.number(count)}`,
      )
    }
  }

  if (status.rate_limits.active_flood_waits.length > 0) {
    console.log()
    console.log(c.error(`  ${icons.warning} Active Flood Waits:`))
    for (const fw of status.rate_limits.active_flood_waits) {
      const remaining = fw.remaining_seconds
      const remainingStr =
        remaining > 0 ? `${remaining}s remaining` : 'expiring soon'
      console.log(
        `    ${c.red(icons.bullet)} ${c.value(fw.method)}${accountTag(status, fw.account_id)} ${c.dim(icons.arrow)} ${c.warning(remainingStr)}`,
      )
    }
  } else {
    printRow('Flood Waits', c.success('None'))
  }
}

function printAccountsSection(status: StatusSnapshot): void {
  printHeader('Accounts')
  printRow('Total', c.number(status.accounts.total))

  if (status.accounts.active_phone) {
    const activeName = status.accounts.active_name
      ? ` (${status.accounts.active_name})`
      : ''
    const activeUsername = status.accounts.active_username
      ? ` @${status.accounts.active_username}`
      : ''
    const activeLabel = status.accounts.active_label
      ? ` [${status.accounts.active_label}]`
      : ''
    printRow(
      'Active',
      `${c.success(status.accounts.active_phone)}${c.dim(activeName)}${c.dim(activeUsername)}${c.dim(activeLabel)}`,
    )
  } else {
    printRow('Active', c.warning('None'))
  }

  // With --account the list holds that account only; its line still shows
  if (status.accounts.total <= 1) {
    return
  }

  console.log()
  for (const acc of status.accounts.accounts) {
    const activeMarker = acc.is_active ? c.success(icons.success) : c.dim(' ')
    const name = acc.name ? c.dim(` ${acc.name}`) : ''
    const username = acc.username ? c.dim(` @${acc.username}`) : ''
    const label = acc.label ? c.dim(` [${acc.label}]`) : ''
    console.log(
      `    ${activeMarker} ${c.cyan(`#${acc.id}`)} ${c.value(acc.phone)}${name}${username}${label}`,
    )
    console.log(`      ${accountSummary(acc)}`)
  }
}

type StatusAccount = StatusSnapshot['accounts']['accounts'][number]

/** One account's own figures, on the line under it */
function accountSummary(acc: StatusAccount): string {
  if (acc.cache.status === 'error') {
    return c.red(`cache error: ${acc.cache.error ?? 'unknown'}`)
  }
  if (acc.cache.status === 'missing') return c.dim('no cache yet')

  const parts: string[] = []
  if (acc.connection) {
    const color = acc.connection.status === 'connected' ? c.success : c.warning
    parts.push(color(acc.connection.status))
  }
  const { pending_jobs, running_jobs, failed_jobs } = acc.sync
  parts.push(
    `${c.number(pending_jobs + running_jobs)} queued`,
    ...(failed_jobs > 0 ? [c.red(`${failed_jobs} failed`)] : []),
    `history ${c.number(acc.progress.chats_history_complete)}${c.dim('/')}${c.number(acc.progress.chats_enabled)}`,
    `${c.number(acc.progress.messages_cached.toLocaleString())} msgs`,
    `${c.number(acc.rate_limits.api_calls_last_minute)} calls/min`,
  )
  if (acc.rate_limits.active_flood_waits > 0) {
    parts.push(c.warning(`${acc.rate_limits.active_flood_waits} flood waits`))
  }
  return parts.join(c.dim(' · '))
}

/**
 * Shared caches of an older version that were set aside, and a move that
 * waits; shown only when there is one
 */
function printStorageSection(status: StatusSnapshot): void {
  const { legacy_caches, migration } = status.storage
  if (legacy_caches.length === 0 && !migration) return

  printHeader('Storage')
  if (migration) {
    printRow('Shared cache', c.warning(`not moved yet (${migration.reason})`))
    console.log(`    ${c.dim(migration.path)}`)
    console.log(`    ${c.dim(migration.suggestion)}`)
  }
  for (const file of legacy_caches) {
    printRow(
      'Set aside',
      `${c.value(file.path)} ${c.dim(formatBytes(file.size_bytes))}`,
    )
  }
  if (legacy_caches.length > 0) {
    console.log(
      c.dim(
        `  A shared cache from an older version can't be split by account; see ${UPGRADE_DOCS_URL}`,
      ),
    )
  }
}

/**
 * With --account, a line under the title says which account the figures
 * cover, so they don't read as totals over every account
 */
function printScope(status: StatusSnapshot): void {
  if (status.account_id === null) return
  const account = status.accounts.accounts.find(
    (acc) => acc.id === status.account_id,
  )
  const label = account?.label ? ` [${account.label}]` : ''
  const phone = account ? ` ${account.phone}` : ''
  console.log(
    c.warning(
      `  Only account #${status.account_id}${phone}${label}; Daemon covers every account`,
    ),
  )
}

export function printPrettyStatus(status: StatusSnapshot): void {
  console.log()
  console.log(c.bold('  Telegram Sync CLI Status'))
  console.log(c.dim(`  ${status.timestamp}`))
  printScope(status)

  printDaemonSection(status)
  printSyncJobsSection(status)
  printSyncProgressSection(status)
  printRateLimitsSection(status)
  printAccountsSection(status)
  printStorageSection(status)

  console.log()
}
