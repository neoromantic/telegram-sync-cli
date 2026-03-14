import { SyncJobStatus } from '../../db/sync-schema'
import { formatBytes, formatRelativeTime } from '../../utils/formatting'
import { formatDuration } from '../../utils/time'
import type { collectStatus } from '../status'
import { c, icons, printHeader, printRow } from './formatters'

export type StatusSnapshot = Awaited<ReturnType<typeof collectStatus>>

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
}

function printSyncJobsSection(status: StatusSnapshot): void {
  printHeader('Sync Jobs')

  const totalJobs = status.sync.pending_jobs + status.sync.running_jobs
  if (totalJobs === 0) {
    printRow('Queue', c.dim('Empty'))
    return
  }

  if (status.sync.running_jobs > 0) {
    printRow('Running', c.success(`${status.sync.running_jobs} jobs`))
  }
  if (status.sync.pending_jobs > 0) {
    printRow('Pending', c.warning(`${status.sync.pending_jobs} jobs`))
  }

  if (status.sync.jobs.length === 0) return

  console.log()
  for (const job of status.sync.jobs) {
    const statusIcon =
      job.status === SyncJobStatus.Running
        ? c.success(icons.running)
        : c.yellow(icons.pending)
    const fetched =
      job.messages_fetched > 0 ? c.dim(` (${job.messages_fetched} msgs)`) : ''
    console.log(
      `    ${statusIcon} ${c.cyan(`#${job.id}`)} ${c.value(job.type)} ${c.dim(`chat:${job.chat_id}`)}${fetched}`,
    )
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
        `    ${c.dim(icons.bullet)} ${c.value(chat.chat_type)} ${c.dim(`chat:${chat.chat_id}`)} ${c.dim(icons.arrow)} ${synced} msgs ${c.dim(icons.arrow)} ${state}`,
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
        `    ${c.red(icons.bullet)} ${c.value(fw.method)} ${c.dim(icons.arrow)} ${c.warning(remainingStr)}`,
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

  if (status.accounts.accounts.length <= 1) {
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
  }
}

export function printPrettyStatus(status: StatusSnapshot): void {
  console.log()
  console.log(c.bold('  Telegram Sync CLI Status'))
  console.log(c.dim(`  ${status.timestamp}`))

  printDaemonSection(status)
  printSyncJobsSection(status)
  printSyncProgressSection(status)
  printRateLimitsSection(status)
  printAccountsSection(status)

  console.log()
}
