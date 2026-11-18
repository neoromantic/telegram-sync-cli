/**
 * Daemon module - long-running process for real-time sync
 *
 * Key principles:
 * - READ-ONLY: Never performs mutations (no sending messages)
 * - Foreground: User manages backgrounding via &, tmux, nohup, systemd
 * - Multi-account: Single instance manages all configured accounts (max 5)
 * - Resilient: Handles disconnections, rate limits, and errors gracefully
 */

export { createDaemon, type Daemon } from './daemon'
export { createPidFile, type PidFile, PidFileError } from './pid-file'
export {
  createSyncScheduler,
  type SchedulerStatus,
  type SyncScheduler,
} from './scheduler'
export { type DaemonConfig, DaemonExitCode, type DaemonState } from './types'
