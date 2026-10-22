/**
 * Daemon types and interfaces
 */
import type {
  DeleteMessageUpdate,
  Message,
  RawUpdateInfo,
  TelegramClient,
} from '@mtcute/bun'
import type { UpdateHandlers } from './handlers'

/**
 * Event handler references for cleanup
 * These are the actual function references registered with mtcute events
 */
export interface AccountEventHandlers {
  /** Handler for new messages */
  onNewMessage: (msg: Message) => void
  /** Handler for edited messages */
  onEditMessage: (msg: Message) => void
  /** Handler for deleted messages */
  onDeleteMessage: (update: DeleteMessageUpdate) => void
  /** Handler for raw updates: contact changes (#8) */
  onRawUpdate: (info: RawUpdateInfo) => void
}

/**
 * Daemon exit codes
 */
export enum DaemonExitCode {
  /** Clean shutdown */
  Success = 0,
  /** General error */
  Error = 1,
  /** Already running (PID file exists with live process) */
  AlreadyRunning = 2,
  /** No accounts configured */
  NoAccounts = 3,
  /** All accounts failed to connect */
  AllAccountsFailed = 4,
}

/**
 * Daemon verbosity level
 */
export type DaemonVerbosity = 'quiet' | 'normal' | 'verbose'

/**
 * Reconnection configuration
 */
export interface ReconnectConfig {
  /** Initial delay in milliseconds before first reconnection attempt */
  initialDelayMs: number
  /** Maximum delay in milliseconds between reconnection attempts */
  maxDelayMs: number
  /** Maximum number of reconnection attempts before giving up */
  maxAttempts: number
  /** Multiplier for exponential backoff (e.g., 2 means double the delay each time) */
  backoffMultiplier: number
}

/**
 * Default reconnection configuration
 */
export const DEFAULT_RECONNECT_CONFIG: ReconnectConfig = {
  initialDelayMs: 5000, // 5 seconds
  maxDelayMs: 300000, // 5 minutes
  maxAttempts: 10,
  backoffMultiplier: 2,
}

/**
 * Daemon configuration
 */
export interface DaemonConfig {
  /** Verbosity level */
  verbosity: DaemonVerbosity
  /** Data directory path */
  dataDir: string
  /** PID file path */
  pidPath: string
  /** Reconnection configuration */
  reconnectConfig?: ReconnectConfig
  /** Delay between pagination calls within a single job (ms) */
  interBatchDelayMs: number
  /** Delay between different sync jobs (ms) */
  interJobDelayMs: number
  /** Shutdown timeout in milliseconds - force exit if cleanup takes longer */
  shutdownTimeoutMs?: number
}

/**
 * Default sync delay configuration
 */
export const DEFAULT_SYNC_DELAYS = {
  /** Default inter-batch delay: 1 second */
  interBatchDelayMs: 1000,
  /** Default inter-job delay: 3 seconds */
  interJobDelayMs: 3000,
} as const

/**
 * Default shutdown timeout in milliseconds (30 seconds)
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000

/**
 * Account connection state
 */
export interface AccountConnectionState {
  /** Account ID */
  accountId: number
  /** Account phone number */
  phone: string
  /** Account display name */
  name: string | null
  /** Connection status */
  status: 'connecting' | 'connected' | 'disconnected' | 'error' | 'reconnecting'
  /** Last error message */
  lastError?: string
  /** Last activity timestamp */
  lastActivity?: number
  /** Telegram client instance */
  client?: TelegramClient
  /** Number of reconnection attempts since last successful connection */
  reconnectAttempts?: number
  /** Timestamp when next reconnection attempt should occur */
  nextReconnectAt?: number
  /** Update handlers for this account */
  updateHandlers?: UpdateHandlers
  /** Event handler references for cleanup */
  eventHandlers?: AccountEventHandlers
}

/**
 * Daemon state
 */
export interface DaemonState {
  /** Whether daemon is running */
  running: boolean
  /** Start timestamp */
  startedAt?: number
  /** Connected accounts */
  accounts: Map<number, AccountConnectionState>
  /** Shutdown signal received */
  shutdownRequested: boolean
}

/**
 * Logger interface for daemon components
 */
export interface DaemonLogger {
  info(message: string): void
  debug(message: string): void
  warn(message: string): void
  error(message: string): void
}

/**
 * Daemon status for display
 */
export interface DaemonStatus {
  /** Whether daemon is running */
  running: boolean
  /** Process ID */
  pid: number | null
  /** Uptime in milliseconds */
  uptimeMs: number | null
  /** Connected accounts count */
  connectedAccounts: number
  /** Total accounts count */
  totalAccounts: number
  /** Account details */
  accounts: Array<{
    id: number
    phone: string
    name: string | null
    status: string
    lastError?: string
  }>
  /** Messages synced count */
  messagesSynced: number
  /** Last update timestamp */
  lastUpdate: number | null
}
