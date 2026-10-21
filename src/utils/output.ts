/**
 * Output utilities for consistent CLI output
 */
import type { ErrorCode, Output, OutputFormat } from '../types'

/** Current output format (can be overridden per-command) */
let currentFormat: OutputFormat = 'json'

/**
 * Set the output format
 */
export function setOutputFormat(format: OutputFormat): void {
  currentFormat = format
}

/**
 * Get current output format
 */
export function getOutputFormat(): OutputFormat {
  return currentFormat
}

/**
 * Output success result
 * Note: In production mode, this exits the process to close any active connections.
 * In test mode, this just logs and returns.
 */
export function success<T>(data: T): void {
  const result: Output<T> = { success: true, data }

  switch (currentFormat) {
    case 'json':
      console.log(JSON.stringify(result, null, 2))
      break
    case 'pretty':
      console.log(JSON.stringify(data, null, 2))
      break
    case 'quiet':
      // No output for quiet mode
      break
  }

  // In production mode, exit to close any active connections (e.g., mtcute TelegramClient)
  // This prevents the process from hanging when the event loop is kept alive by open sockets
  if (process.env.BUN_ENV !== 'test' && process.env.NODE_ENV !== 'test') {
    process.exit(0)
  }
}

/**
 * Output error result
 * Note: In test mode, this throws instead of calling process.exit
 */
export function error(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
  suggestion?: string,
): never {
  const result: Output<never> = {
    success: false,
    error: { code, message, details, suggestion },
  }

  if (currentFormat !== 'quiet') {
    console.error(JSON.stringify(result, null, 2))
  }

  // In test mode, throw instead of exiting
  if (process.env.BUN_ENV === 'test' || process.env.NODE_ENV === 'test') {
    const err = new Error(message) as Error & {
      code: ErrorCode
      details?: Record<string, unknown>
    }
    err.code = code
    err.details = details
    throw err
  }

  // Map error codes to exit codes
  const exitCode = getExitCode(code)
  process.exit(exitCode)
}

/**
 * Map error code to exit code
 */
export function getExitCode(code: ErrorCode): number {
  const exitCodes: Record<ErrorCode, number> = {
    AUTH_REQUIRED: 2,
    INVALID_ARGS: 3,
    NETWORK_ERROR: 4,
    TELEGRAM_ERROR: 5,
    RATE_LIMITED: 5,
    ACCOUNT_NOT_FOUND: 6,
    NO_ACTIVE_ACCOUNT: 1,
    CACHE_UNAVAILABLE: 1,
    PHONE_CODE_INVALID: 1,
    SESSION_PASSWORD_NEEDED: 1,
    DAEMON_NOT_RUNNING: 1,
    DAEMON_ALREADY_RUNNING: 1,
    DAEMON_SIGNAL_FAILED: 1,
    DAEMON_SHUTDOWN_TIMEOUT: 1,
    DAEMON_FORCE_KILL_FAILED: 1,
    GENERAL_ERROR: 1,
    SQL_WRITE_NOT_ALLOWED: 1,
    SQL_SYNTAX_ERROR: 1,
    SQL_TABLE_NOT_FOUND: 1,
    SQL_OPERATION_BLOCKED: 1,
  }

  return exitCodes[code] ?? 1
}

/**
 * Log verbose output (only in verbose mode)
 */
export function verbose(message: string): void {
  if (process.env.VERBOSE === '1') {
    console.error(`[verbose] ${message}`)
  }
}

/**
 * Log info message (not in quiet mode)
 */
export function info(message: string): void {
  if (currentFormat !== 'quiet') {
    console.error(message)
  }
}
