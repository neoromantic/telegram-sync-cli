import type { TelegramClient } from '@mtcute/bun'
import { getErrorMessage } from './daemon-utils'
import type { DaemonLogger, DaemonVerbosity } from './types'

export function createLogger(verbosity: DaemonVerbosity): DaemonLogger {
  const shouldLog = {
    info: verbosity !== 'quiet',
    debug: verbosity === 'verbose',
    warn: true,
    error: true,
  }

  const timestamp = () => new Date().toISOString()

  return {
    info(message: string) {
      if (shouldLog.info) console.log(`[${timestamp()}] [INFO] ${message}`)
    },
    debug(message: string) {
      if (shouldLog.debug) console.log(`[${timestamp()}] [DEBUG] ${message}`)
    },
    warn(message: string) {
      if (shouldLog.warn) console.warn(`[${timestamp()}] [WARN] ${message}`)
    },
    error(message: string) {
      if (shouldLog.error) console.error(`[${timestamp()}] [ERROR] ${message}`)
    },
  }
}

/**
 * A phone number with only its first two and last two digits shown:
 * `+15550000000` is `+15*******00`. Logs get pasted into issues (#128).
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 6) return '***'
  return `+${digits.slice(0, 2)}${'*'.repeat(digits.length - 4)}${digits.slice(-2)}`
}

/**
 * How the daemon names an account in its log: `#1 (@username)`, else
 * `#1 (+15*******00)`. Never the full phone number or the name (#128).
 */
export function accountLabel(account: {
  accountId: number
  phone: string
  username?: string | null
}): string {
  if (account.username) return `#${account.accountId} (@${account.username})`
  // An account added by user ID has a placeholder, not a phone
  if (!account.phone || account.phone.startsWith('user:')) {
    return `#${account.accountId}`
  }
  return `#${account.accountId} (${maskPhone(account.phone)})`
}

// mtcute's log levels (LogManager.ERROR, WARN, DEBUG)
const MTCUTE_ERROR = 1
const MTCUTE_WARN = 2

/** Same error again within this window: debug level, not another warning */
const REPEATED_ERROR_WINDOW_MS = 5 * 60 * 1000

/**
 * mtcute fills in `%j` (JSON) and `%e` (an error's stack) before the daemon
 * sees the line. A payload is a Telegram object that may hold users (phone,
 * name) or message text: only its type is kept, `<messages.dialogs>`.
 */
function stripPayloadsAndStacks(text: string): string {
  return (
    text
      // A stack's frames: "\n    at fn (file:1:2)"
      .replace(/\n\s*at\s[^\n]*/g, '')
      // From the first JSON object or array to the end of the line
      .replace(
        /(\[\s*)?\{"_":"([\w.]+)"[\s\S]*$/,
        (_m, _arr, type) => `<${type}>`,
      )
      .replace(/\[?\s*[{[]"[\s\S]*$/, '<payload>')
  )
}

/**
 * One line of mtcute's log: its format filled in, an error by its message,
 * a Telegram object by its type, never a stack or a payload (#128)
 */
export function formatClientLog(fmt: string, args: unknown[]): string {
  const rest = [...args]
  const text = stripPayloadsAndStacks(
    fmt
      // mtcute adds the account's user ID; the daemon's tag names the account
      .replace(/^\[USER [^\]]*\] /, ''),
  ).replace(/%[sdifo]/gi, () => {
    if (rest.length === 0) return ''
    return describeArg(rest.shift())
  })
  const extra = rest.map(describeArg).filter((part) => part.length > 0)
  return [text.trim(), ...extra].join(' ').replace(/\s+/g, ' ').trim()
}

function describeArg(value: unknown): string {
  if (value instanceof Error) return getErrorMessage(value)
  if (typeof value === 'object' && value !== null) {
    const type = (value as { _?: unknown })._
    return typeof type === 'string' ? `<${type}>` : '<object>'
  }
  return String(value)
}

/**
 * Route the client's own log and errors through the daemon's logger, one
 * line each, never a dumped error object (Bun prints the compiled binary's
 * source with one). mtcute's warnings show only with `--verbose`, its update
 * gap chatter at debug level; its errors always do (#128).
 */
export function routeClientLogs(
  client: TelegramClient,
  logger: DaemonLogger,
  verbosity: DaemonVerbosity,
  tag: string,
  now: () => number = Date.now,
): void {
  const mgr = client.log.mgr
  mgr.level = verbosity === 'verbose' ? MTCUTE_WARN : MTCUTE_ERROR
  mgr.handler = (_color, level, logTag, fmt, args) => {
    const line = `${tag} [mtcute ${logTag}] ${formatClientLog(fmt, args)}`
    if (level <= MTCUTE_ERROR) logger.error(line)
    // The update manager's gap chatter (pts_before does not match …) is
    // normal on a busy account: hundreds of lines a day
    else if (level === MTCUTE_WARN && logTag !== 'updates') logger.warn(line)
    else logger.debug(line)
  }

  // A client with an error handler never prints "unhandled error". A
  // dropped network repeats the same error on every retry: one warning.
  let lastError: { message: string; at: number } | undefined
  client.onError.add((err) => {
    const message = getErrorMessage(err).replace(/\s+/g, ' ').trim()
    const at = now()
    const repeated =
      lastError?.message === message &&
      at - lastError.at < REPEATED_ERROR_WINDOW_MS
    if (!repeated) lastError = { message, at }
    const line = `${tag} Telegram client error: ${message}`
    if (repeated) logger.debug(line)
    else logger.warn(line)
  })
}
