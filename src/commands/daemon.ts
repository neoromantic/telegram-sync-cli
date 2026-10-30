/**
 * Daemon command - manage background sync daemon
 *
 * Usage:
 *   tg daemon start [--verbose|--quiet]  Start daemon in foreground
 *   tg daemon stop                       Stop running daemon
 *   tg daemon status                     Show daemon status
 */

import { join } from 'node:path'
import { defineCommand } from 'citty'
import { loadDaemonConfig } from '../config'
import { createDaemon, createPidFile, DaemonExitCode } from '../daemon'
import { createLogger } from '../daemon/daemon-logger'
import { accountsDb, getDataDir } from '../db'
import { summarizeDaemonStatus } from '../db/daemon-status'
import { exitAfterFlush, reportDaemonExit } from '../telemetry'
import { ErrorCodes } from '../types'
import { error, info, success } from '../utils/output'
import { formatDuration } from '../utils/time'
import {
  collectStorageStatus,
  liveConnection,
  readAccountStatus,
} from './status'

/**
 * Start subcommand - starts daemon in foreground
 */
const startCommand = defineCommand({
  meta: {
    name: 'start',
    description: 'Start the daemon in foreground',
  },
  args: {
    verbose: {
      type: 'boolean',
      description: 'Enable verbose logging',
      alias: 'v',
      default: false,
    },
    quiet: {
      type: 'boolean',
      description: 'Minimal output (errors only)',
      alias: 'q',
      default: false,
    },
  },
  async run({ args }) {
    const verbosity = args.quiet ? 'quiet' : args.verbose ? 'verbose' : 'normal'
    // Read once: a change takes effect at the next start. A bad config
    // never keeps the daemon from starting.
    const { retention, pacing, warning } = await loadDaemonConfig()
    if (warning) createLogger(verbosity).warn(warning)
    const daemon = createDaemon({ verbosity, retention, pacing })
    const exitCode = await daemon.start()

    reportDaemonExit(exitCode, DaemonExitCode[exitCode])
    await exitAfterFlush(exitCode)
  },
})

/**
 * Stop subcommand - sends SIGTERM to running daemon
 */
const stopCommand = defineCommand({
  meta: {
    name: 'stop',
    description: 'Stop the running daemon',
  },
  args: {
    timeout: {
      type: 'string',
      description: 'Timeout in seconds to wait for graceful shutdown',
      default: '10',
    },
    force: {
      type: 'boolean',
      description: 'Force kill if graceful shutdown fails',
      alias: 'f',
      default: false,
    },
  },
  async run({ args }) {
    const dataDir = getDataDir()
    const pidPath = join(dataDir, 'daemon.pid')
    const pidFile = createPidFile(pidPath)

    const pid = pidFile.read()
    if (pid === null) {
      error(ErrorCodes.DAEMON_NOT_RUNNING, 'Daemon is not running')
    }

    const timeoutMs = parseInt(args.timeout, 10) * 1000

    // Send SIGTERM
    info(`Stopping daemon (PID ${pid})...`)
    if (!pidFile.sendSignal('SIGTERM')) {
      error(
        ErrorCodes.DAEMON_SIGNAL_FAILED,
        'Failed to send stop signal to daemon',
      )
    }

    // Wait for process to exit
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      if (!pidFile.isRunning()) {
        success({ message: 'Daemon stopped successfully' })
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    // Graceful shutdown timed out
    if (!args.force) {
      error(
        ErrorCodes.DAEMON_SHUTDOWN_TIMEOUT,
        `Daemon did not stop within ${args.timeout} seconds. Use --force to forcefully kill.`,
      )
    }

    info('Graceful shutdown timed out, forcing kill...')
    if (pidFile.sendSignal('SIGKILL')) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (!pidFile.isRunning()) {
        success({ message: 'Daemon forcefully stopped' })
        return
      }
    }

    error(
      ErrorCodes.DAEMON_FORCE_KILL_FAILED,
      'Failed to forcefully stop daemon',
    )
  },
})

/**
 * Status subcommand - shows daemon status, as totals over the accounts'
 * caches
 */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show daemon status',
  },
  async run() {
    const dataDir = getDataDir()
    const pidPath = join(dataDir, 'daemon.pid')
    const pidFile = createPidFile(pidPath)

    const pid = pidFile.read()

    if (pid === null) {
      success({
        status: 'stopped',
        pid: null,
        message: 'Daemon is not running',
      })
      return
    }

    // Moves a shared cache first; a move that waits (an older daemon still
    // holds it) is why every account below may read as empty
    const storage = collectStorageStatus(dataDir)
    const snapshots = accountsDb
      .getAll()
      .map((account) => readAccountStatus(account.id))
    const livePid = pidFile.isRunning() ? pid : null
    const summary = summarizeDaemonStatus(
      snapshots.flatMap((snapshot) =>
        snapshot.daemon ? [snapshot.daemon] : [],
      ),
      livePid,
    )
    const sum = (pick: (snapshot: (typeof snapshots)[number]) => number) =>
      snapshots.reduce((total, snapshot) => total + pick(snapshot), 0)

    success({
      status: 'running',
      pid,
      uptime: summary.startedAt
        ? formatDuration(Date.now() - summary.startedAt)
        : null,
      connectedAccounts: summary.connectedAccounts,
      totalAccounts: summary.totalAccounts,
      messagesSynced: summary.messagesSynced,
      messagesSyncedTotal: sum((s) => s.progress.messages_tracked),
      messagesCached: sum((s) => s.progress.messages_cached),
      chatsEnabled: sum((s) => s.progress.chats_enabled),
      chatsHistoryComplete: sum((s) => s.progress.chats_history_complete),
      lastUpdate: summary.lastUpdate
        ? new Date(summary.lastUpdate).toISOString()
        : null,
      // Each account's share; connection and messagesSynced come from the
      // rows the live daemon wrote
      accounts: snapshots.map((snapshot) => {
        const connection = liveConnection(snapshot, livePid)
        return {
          id: snapshot.accountId,
          connection: connection?.status ?? null,
          lastError: connection?.last_error ?? null,
          messagesSynced: connection
            ? (snapshot.daemon?.messagesSynced ?? 0)
            : 0,
          messagesCached: snapshot.progress.messages_cached,
          chatsEnabled: snapshot.progress.chats_enabled,
          chatsHistoryComplete: snapshot.progress.chats_history_complete,
        }
      }),
      storage,
    })
  },
})

/**
 * Main daemon command
 */
export const daemonCommand = defineCommand({
  meta: {
    name: 'daemon',
    description: 'Manage the background sync daemon',
  },
  subCommands: {
    start: startCommand,
    stop: stopCommand,
    status: statusCommand,
  },
})

export { DaemonExitCode }
