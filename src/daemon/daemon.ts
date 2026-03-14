/**
 * Main daemon implementation
 * Manages Telegram connections, real-time updates, and background sync
 */

import { join } from 'node:path'
import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
  getCacheDb,
  getDataDir,
} from '../db'
import { createDaemonStatusService } from '../db/daemon-status'
import { initSyncSchema } from '../db/sync-schema'
import { getDefaultConfig, validateConfig } from '../services/telegram'
import {
  connectAccount,
  disconnectAllAccounts,
  setupSignalHandlers,
} from './daemon-accounts'
import { bootstrapDialogs } from './daemon-bootstrap'
import { createDaemonRuntime, type DaemonContext } from './daemon-context'
import { createLogger } from './daemon-logger'
import { mainLoop } from './daemon-loop'
import { cleanupScheduler, initializeScheduler } from './daemon-scheduler'
import { formatError } from './daemon-utils'
import { createPidFile } from './pid-file'
import {
  type DaemonConfig,
  DaemonExitCode,
  type DaemonLogger,
  type DaemonState,
  type DaemonStatus,
  DEFAULT_RECONNECT_CONFIG,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
} from './types'

/**
 * Daemon interface
 */
export interface Daemon {
  /** Start the daemon */
  start(): Promise<DaemonExitCode>
  /** Request graceful shutdown */
  stop(): void
  /** Get current status */
  getStatus(): DaemonStatus
  /** Check if daemon is running */
  isRunning(): boolean
}

/**
 * Calculate the delay for the next reconnection attempt using exponential backoff
 */
export { calculateReconnectDelay } from './daemon-utils'

function createContext(
  config: Partial<DaemonConfig>,
  accountsDb: AccountsDbInterface,
  logger: DaemonLogger,
): DaemonContext {
  const dataDir = config.dataDir ?? getDataDir()
  const pidPath = config.pidPath ?? join(dataDir, 'daemon.pid')
  const verbosity = config.verbosity ?? 'normal'
  const reconnectConfig = config.reconnectConfig ?? DEFAULT_RECONNECT_CONFIG
  const shutdownTimeoutMs =
    config.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS

  const pidFile = createPidFile(pidPath)

  const state: DaemonState = {
    running: false,
    accounts: new Map(),
    shutdownRequested: false,
  }

  return {
    dataDir,
    pidPath,
    verbosity,
    reconnectConfig,
    shutdownTimeoutMs,
    logger,
    pidFile,
    state,
    accountsDb,
    runtime: createDaemonRuntime(),
  }
}

async function initializeDatabase(ctx: DaemonContext): Promise<boolean> {
  try {
    const cacheDb = getCacheDb()
    initSyncSchema(cacheDb)

    const statusService = createDaemonStatusService(cacheDb)
    ctx.runtime.statusService = statusService
    statusService.setDaemonRunning(process.pid)

    return true
  } catch (err) {
    ctx.logger.error(`Failed to initialize database: ${formatError(err)}`)
    return false
  }
}

async function connectAccounts(ctx: DaemonContext): Promise<number> {
  const accounts = ctx.accountsDb.getAll()
  ctx.logger.info(`Connecting ${accounts.length} account(s)...`)

  const connectionResults = await Promise.all(
    accounts.map((account) =>
      connectAccount(ctx, account.id, account.phone, account.name ?? null),
    ),
  )

  return connectionResults.filter(Boolean).length
}

async function cleanupWithTimeout(
  ctx: DaemonContext,
  task: () => Promise<void>,
): Promise<void> {
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error('Shutdown timeout exceeded'))
    }, ctx.shutdownTimeoutMs)
  })

  try {
    await Promise.race([task(), timeoutPromise])
  } catch (err) {
    if (err instanceof Error && err.message === 'Shutdown timeout exceeded') {
      ctx.logger.warn(
        `Shutdown timeout (${ctx.shutdownTimeoutMs}ms) exceeded - forcing exit`,
      )
      ctx.pidFile.release()
      process.exit(1)
    }
    throw err
  }
}

async function performCleanup(ctx: DaemonContext): Promise<void> {
  const cleanupWork = async () => {
    cleanupScheduler(ctx)
    await disconnectAllAccounts(ctx)

    try {
      const statusService =
        ctx.runtime.statusService ?? createDaemonStatusService(getCacheDb())
      statusService.setDaemonStopped()
    } catch (err) {
      ctx.logger.warn(
        `Failed to update daemon status on shutdown: ${formatError(err)}`,
      )
    }

    ctx.pidFile.release()
    ctx.state.running = false
  }

  await cleanupWithTimeout(ctx, cleanupWork)
}

async function startDaemon(ctx: DaemonContext): Promise<DaemonExitCode> {
  ctx.logger.info('Starting Telegram Sync CLI daemon...')

  let exitCode = DaemonExitCode.Success

  if (ctx.pidFile.isRunning()) {
    const pid = ctx.pidFile.read()
    ctx.logger.error(`Daemon already running with PID ${pid}`)
    exitCode = DaemonExitCode.AlreadyRunning
  }

  const telegramConfig = getDefaultConfig()
  const validation = validateConfig(telegramConfig)
  if (exitCode === DaemonExitCode.Success && !validation.valid) {
    ctx.logger.error(`Configuration error: ${validation.error}`)
    exitCode = DaemonExitCode.Error
  }

  const accounts = ctx.accountsDb.getAll()
  if (exitCode === DaemonExitCode.Success && accounts.length === 0) {
    ctx.logger.error('No accounts configured. Use "tg auth" to add an account.')
    exitCode = DaemonExitCode.NoAccounts
  }

  if (exitCode !== DaemonExitCode.Success) {
    return exitCode
  }

  try {
    ctx.pidFile.acquire()
    ctx.logger.debug(`PID file acquired: ${ctx.pidPath}`)
  } catch (err) {
    ctx.logger.error(`Failed to acquire PID file: ${formatError(err)}`)
    return DaemonExitCode.Error
  }

  setupSignalHandlers(ctx)

  const dbInitialized = await initializeDatabase(ctx)
  if (!dbInitialized) {
    ctx.pidFile.release()
    return DaemonExitCode.Error
  }

  ctx.state.running = true
  ctx.state.startedAt = Date.now()

  const connectedCount = await connectAccounts(ctx)
  ctx.logger.info(`${connectedCount}/${accounts.length} account(s) connected`)

  if (connectedCount === 0) {
    ctx.logger.error('All accounts failed to connect')
    await performCleanup(ctx)
    return DaemonExitCode.AllAccountsFailed
  }

  try {
    await bootstrapDialogs(ctx)
  } catch (err) {
    ctx.logger.warn(`Failed to bootstrap dialogs: ${formatError(err)}`)
  }

  try {
    await initializeScheduler(ctx)
  } catch (err) {
    ctx.logger.error(`Failed to initialize scheduler: ${formatError(err)}`)
  }

  try {
    await mainLoop(ctx)
  } catch (err) {
    ctx.logger.error(`Main loop error: ${formatError(err)}`)
  }

  await performCleanup(ctx)

  ctx.logger.info('Daemon stopped')
  return DaemonExitCode.Success
}

/**
 * Create daemon instance
 */
export function createDaemon(
  config: Partial<DaemonConfig> = {},
  accountsDb: AccountsDbInterface = defaultAccountsDb,
): Daemon {
  const verbosity = config.verbosity ?? 'normal'
  const logger = createLogger(verbosity)
  const ctx = createContext(config, accountsDb, logger)

  return {
    async start(): Promise<DaemonExitCode> {
      return startDaemon(ctx)
    },
    stop(): void {
      ctx.state.shutdownRequested = true
    },
    getStatus(): DaemonStatus {
      const connectedAccounts = Array.from(ctx.state.accounts.values()).filter(
        (a) => a.status === 'connected',
      ).length

      return {
        running: ctx.state.running,
        pid: ctx.state.running ? process.pid : null,
        uptimeMs: ctx.state.startedAt ? Date.now() - ctx.state.startedAt : null,
        connectedAccounts,
        totalAccounts: ctx.state.accounts.size,
        accounts: Array.from(ctx.state.accounts.values()).map((a) => ({
          id: a.accountId,
          phone: a.phone,
          name: a.name,
          status: a.status,
          lastError: a.lastError,
        })),
        messagesSynced: ctx.runtime.totalMessagesSynced,
        lastUpdate: ctx.state.running ? Date.now() : null,
      }
    },
    isRunning(): boolean {
      return ctx.state.running
    },
  }
}
