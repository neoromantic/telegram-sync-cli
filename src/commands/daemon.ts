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
import {
  createDaemon,
  createPidFile,
  type DaemonConfig,
  DaemonExitCode,
} from '../daemon'
import { getCacheDb, getDataDir } from '../db'
import { createDaemonStatusService } from '../db/daemon-status'
import { ErrorCodes } from '../types'
import { error, success } from '../utils/output'
import { formatDuration } from '../utils/time'

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

    const config: Partial<DaemonConfig> = {
      verbosity,
    }

    const daemon = createDaemon(config)
    const exitCode = await daemon.start()

    process.exit(exitCode)
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
    console.log(`Stopping daemon (PID ${pid})...`)
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

    console.log('Graceful shutdown timed out, forcing kill...')
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
 * Status subcommand - shows daemon status
 */
const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Show daemon status',
  },
  args: {},
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

    // Read status from database
    try {
      const cacheDb = getCacheDb()
      const statusService = createDaemonStatusService(cacheDb)
      const info = statusService.getDaemonInfo()

      const uptime = info.startedAt
        ? formatDuration(Date.now() - info.startedAt)
        : null

      let messagesTrackedTotal: number | null = null
      let messagesCached: number | null = null
      let chatsEnabled: number | null = null
      let chatsHistoryComplete: number | null = null

      try {
        const trackedRow = cacheDb
          .query(
            'SELECT COALESCE(SUM(synced_messages), 0) as count FROM chat_sync_state',
          )
          .get() as { count: number } | null
        const cachedRow = cacheDb
          .query('SELECT COUNT(*) as count FROM messages_cache')
          .get() as { count: number } | null
        const enabledRow = cacheDb
          .query(
            'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1',
          )
          .get() as { count: number } | null
        const completeRow = cacheDb
          .query(
            'SELECT COUNT(*) as count FROM chat_sync_state WHERE sync_enabled = 1 AND history_complete = 1',
          )
          .get() as { count: number } | null

        messagesTrackedTotal = trackedRow?.count ?? 0
        messagesCached = cachedRow?.count ?? 0
        chatsEnabled = enabledRow?.count ?? 0
        chatsHistoryComplete = completeRow?.count ?? 0
      } catch {
        // Ignore progress query failures
      }

      success({
        status: 'running',
        pid,
        uptime,
        connectedAccounts: info.connectedAccounts,
        totalAccounts: info.totalAccounts,
        messagesSynced: info.messagesSynced,
        messagesSyncedTotal: messagesTrackedTotal,
        messagesCached,
        chatsEnabled,
        chatsHistoryComplete,
        lastUpdate: info.lastUpdate
          ? new Date(info.lastUpdate).toISOString()
          : null,
      })
    } catch (_err) {
      // Database might not be initialized yet
      success({
        status: 'running',
        pid,
        message: 'Daemon is running (status details unavailable)',
      })
    }
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
