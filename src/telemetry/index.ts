/**
 * Usage stats for tg: which commands run, how often, and which errors they
 * hit. client.ts is devkit's client and is never edited here; this file
 * decides what tg passes to it. What is sent and how to turn it off:
 * https://usage.sergeybaus.com and the README's "Usage stats".
 *
 * - The feature is the command path from the dispatcher (`chats list`),
 *   never an argument. `tg telemetry` records nothing.
 * - An error is sent as its type: the error code, or Telegram's RPC error
 *   (`FLOOD_WAIT`). Messages can name chats, users or a query, so only the
 *   local errors passed to reportLocalError (config file, cache database) add
 *   their message, without account numbers or a data directory the user set;
 *   the client scrubs it of the home directory and user name.
 * - A source checkout sends nothing unless TELEGRAM_SYNC_CLI_TELEMETRY is on.
 * - A command never waits for them: as it exits, it hands its events to a
 *   detached copy of tg that sends them (background.ts). The daemon, which
 *   runs for days, and debug mode send from their own process, and their
 *   exit waits up to 500 ms for the events in flight.
 */
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, normalize, resolve } from 'node:path'
import { VERSION } from '../version'
import {
  type ErrorReport,
  type Handoff,
  isCompiled,
  sendInBackground,
  sentToday,
} from './background'
import {
  type Channel,
  createTelemetry,
  type Mode,
  type Telemetry,
  type TelemetryStatus,
} from './client'

export const PRODUCT = 'telegram-sync-cli'
export const ENV_PREFIX = 'TELEGRAM_SYNC_CLI'
export const OFF_COMMAND = 'tg telemetry off'
export const DETAILS_URL = 'https://usage.sergeybaus.com'
/** Where a source checkout with usage stats on sends them, for tests */
export const ENDPOINT_ENV = `${ENV_PREFIX}_TELEMETRY_ENDPOINT`
const FLUSH_MS = 500
/** How often a running daemon checks in; the client sends once a UTC day */
const HEARTBEAT_MS = 60 * 60 * 1000
/** The command group that manages usage stats, and records none */
const OWN_COMMAND = 'telemetry'

/** The parts of a citty command that the walks below read */
export interface CommandNode {
  args?: unknown
  subCommands?: unknown
  run?: unknown
}

type Run = (context: unknown) => unknown
type Env = Record<string, string | undefined>

/** Thrown by error() while an exit waits for usage stats; see exitAfterFlush */
export class ExitPending extends Error {
  constructor() {
    super('tg is exiting')
    this.name = 'ExitPending'
  }
}

let root: CommandNode | undefined
/** The client of a daemon or a debug run while it may send, else null */
let tracker: Telemetry | null = null
/** A command's events until its exit hands them over, else null */
let handoff: Handoff | null = null
let stateFile = ''
let exiting = false
let errorReported = false
let completed = false

function children(cmd: CommandNode): Record<string, CommandNode> {
  const subs = cmd.subCommands
  return subs && typeof subs === 'object'
    ? (subs as Record<string, CommandNode>)
    : {}
}

/** Every command path the dispatcher knows (`chats list`, `send`), tg telemetry's aside */
export function commandPaths(
  cmd: CommandNode,
  prefix: string[] = [],
): string[] {
  return Object.entries(children(cmd)).flatMap(([name, sub]) => {
    if (prefix.length === 0 && name === OWN_COMMAND) return []
    const path = [...prefix, name]
    const below = commandPaths(sub, path)
    return typeof sub.run === 'function' || below.length === 0
      ? [path.join(' '), ...below]
      : below
  })
}

const camel = (name: string) =>
  name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())

/** Where the subcommand's name is in `args`, as citty finds it */
function subCommandIndex(args: string[], defs: unknown): number {
  const valueFlags = new Set<string>()
  for (const [key, def] of Object.entries(defs ?? {})) {
    const d = def as { type?: string; alias?: string | string[] }
    if (d.type !== 'string' && d.type !== 'enum') continue
    valueFlags.add(camel(key))
    for (const alias of [d.alias ?? []].flat()) valueFlags.add(alias)
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    if (arg === '--') return -1
    if (!arg.startsWith('-')) return i
    const name = arg.replace(/^-{1,2}/, '')
    if (
      !arg.includes('=') &&
      (valueFlags.has(camel(name)) || valueFlags.has(name))
    ) {
      i++
    }
  }
  return -1
}

/**
 * The command path that `rawArgs` runs, without its arguments. A name the
 * dispatcher doesn't know ends the path; the client sends it as "other".
 */
export function commandPath(cmd: CommandNode, rawArgs: string[]): string[] {
  const path: string[] = []
  let node = cmd
  let rest = rawArgs
  for (;;) {
    const subs = children(node)
    if (Object.keys(subs).length === 0) return path
    const i = subCommandIndex(rest, node.args)
    const name = rest[i]
    if (i < 0 || name === undefined) return path
    const next = Object.hasOwn(subs, name) ? subs[name] : undefined
    if (!next) return [...path, name]
    path.push(name)
    node = next
    rest = rest.slice(i + 1)
  }
}

/**
 * How this tg was installed: a compiled binary runs its modules from Bun's
 * embedded file system, from a Homebrew Cellar or elsewhere; the npm package
 * runs from node_modules; anything else is a source checkout (bun link too).
 */
export function detectChannel(
  modulePath: string = import.meta.path,
  execPath: string = process.execPath,
): Channel {
  if (isCompiled(modulePath)) {
    let real = execPath
    try {
      real = realpathSync(execPath)
    } catch {
      // keep the path as given
    }
    return /[\\/]Cellar[\\/]/.test(real) ? 'homebrew' : 'binary'
  }
  return /[\\/]node_modules[\\/]/.test(modulePath) ? 'npm' : 'source'
}

/** TELEGRAM_SYNC_CLI_TELEMETRY turns usage stats on (debug only prints them) */
function optedIn(env: Env): boolean {
  const value = (env[`${ENV_PREFIX}_TELEMETRY`] ?? '').trim().toLowerCase()
  return ['1', 'on', 'true', 'debug'].includes(value)
}

/**
 * The client for this tg, for a run (`mode`) or for tg telemetry. The copy
 * that sends a command's events passes the run's terminal (`tty`) and its
 * feature.
 */
export function createTgTelemetry(
  options: {
    mode?: Mode
    channel?: Channel
    env?: Env
    tty?: boolean
    features?: string[]
  } = {},
): Telemetry {
  const env = options.env ?? process.env
  const channel = options.channel ?? detectChannel()
  return createTelemetry({
    product: PRODUCT,
    version: VERSION,
    envPrefix: ENV_PREFIX,
    stateDir:
      env.TELEGRAM_SYNC_CLI_DATA_DIR ?? join(homedir(), '.telegram-sync-cli'),
    channel,
    mode: options.mode,
    features: options.features ?? (root ? commandPaths(root) : []),
    offCommand: OFF_COMMAND,
    env,
    tty: options.tty,
    // A checkout runs the maintainer's and contributors' tg: no endpoint
    // unless usage stats are on, then the default or a test server's
    ...(channel === 'source' && {
      endpoint: optedIn(env) ? env[ENDPOINT_ENV] || undefined : '',
    }),
  })
}

/** tg telemetry status: the client's status and the channel */
export function telemetryStatus(
  t: Telemetry = createTgTelemetry(),
): TelemetryStatus & { channel: Channel } {
  return { ...t.status(), channel: detectChannel() }
}

/**
 * Registers the dispatcher, for the feature names, and wraps every command's
 * run so an error it throws is reported, as its type, before citty prints
 * it.
 */
export function instrumentCommands(cmd: CommandNode): void {
  root = cmd
  const wrap = (node: CommandNode) => {
    for (const sub of Object.values(children(node))) {
      wrap(sub)
      const run = sub.run
      if (typeof run !== 'function') continue
      sub.run = async (context: unknown) => {
        try {
          const result = await (run as Run)(context)
          completed = true
          return result
        } catch (err) {
          reportErrorType(err)
          throw err
        }
      }
    }
  }
  wrap(cmd)
}

/**
 * The start of a run: the notice once (not in quiet mode), then app_started
 * and the command. The run that shows the notice sends nothing. A command
 * keeps its events for its exit to hand over; a daemon that runs for days
 * sends them itself, and checks in every hour, which the client sends once
 * a UTC day. `env` and `channel` are for tests.
 */
export function startTelemetry(
  rawArgs: string[],
  options: { quiet?: boolean; env?: Env; channel?: Channel } = {},
): void {
  try {
    if (!root) return
    const path = commandPath(root, rawArgs)
    if (path[0] === OWN_COMMAND) return
    const feature = path.join(' ')
    const mode = feature === 'daemon start' ? 'daemon' : undefined
    const channel = options.channel ?? detectChannel()
    const env = options.env ?? process.env
    const t = createTgTelemetry({ mode, channel, env })
    const status = t.status()
    if (!status.enabled) return
    if (!options.quiet && t.showNotice()) return
    if (mode !== 'daemon' && !status.debug) {
      // A notice not shown yet (no terminal, -q) means nothing to send
      if (t.noticeText()) return
      const known = commandPaths(root).includes(feature)
      handoff = {
        channel,
        tty: !!(process.stdin.isTTY || process.stderr.isTTY),
        calls: [['started']],
      }
      if (feature) handoff.calls.push(['feature', known ? feature : 'other'])
      stateFile = status.stateFile
      // Every way out, process.exit or the end of the event loop
      process.once('exit', () => handOff(env))
      return
    }
    tracker = t
    t.started()
    if (feature) t.feature(feature)
    if (mode === 'daemon') {
      setInterval(() => {
        t.started()
        t.feature(feature)
      }, HEARTBEAT_MS).unref()
    }
  } catch {
    // Usage stats never fail tg
  }
}

/**
 * Telegram's error name from an mtcute message, numbers dropped: FLOOD_WAIT.
 * tg may add a hint after it (`PEER_ID_INVALID (run tg chats list …)`).
 */
export function rpcErrorType(message: string): string | null {
  const text = /Telegram API error -?\d+: ([A-Z0-9_%]+)(?![\w%])/.exec(
    message,
  )?.[1]
  return text ? text.replace(/_(?:%d|\d+)(?=_|$)/g, '') : null
}

/** What error() reports: its code, or for a Telegram error the RPC error's name */
export function cliErrorType(code: string, message: string): string {
  if (code === 'TELEGRAM_ERROR' || code === 'RATE_LIMITED') {
    return (
      rpcErrorType(message) ?? (code === 'RATE_LIMITED' ? 'FLOOD_WAIT' : code)
    )
  }
  return code
}

/** An error's type alone: the RPC error's name, its code or its class */
export function errorType(err: unknown): string {
  if (typeof err !== 'object' || err === null) return 'Error'
  const e = err as { code?: unknown; name?: unknown; message?: unknown }
  const rpc = typeof e.message === 'string' ? rpcErrorType(e.message) : null
  if (rpc) return rpc
  if (typeof e.code === 'string' && e.code) return e.code
  if (typeof e.name === 'string' && e.name !== 'Error') return e.name
  return err.constructor?.name || 'Error'
}

function report(err: ErrorReport): void {
  if (errorReported || !(tracker || handoff)) return
  errorReported = true
  if (tracker) tracker.error(err)
  else handoff?.calls.push(['error', err])
}

/** Hands a command's events to a copy of tg that sends them, once */
function handOff(env: Env): void {
  const events = handoff
  handoff = null
  try {
    if (events && !sentToday(stateFile, events, env)) {
      sendInBackground(events, env)
    }
  } catch {
    // Usage stats never fail tg
  }
}

/** The failure error() prints, as its type */
export function reportCliError(code: string, message: string): void {
  report(cliErrorType(code, message))
}

/**
 * A local error's message without tg's account numbers, which its paths
 * carry (`accounts/2/cache.db`, `session_2.db`, `account 2`)
 */
export function withoutAccountIds(message: string): string {
  return message
    .replace(/(accounts[\\/]|session_)\d+/g, '$1<id>')
    .replace(/\b(account) \d+/gi, '$1 <id>')
}

const quoteRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A local error's message with the data directory that
 * TELEGRAM_SYNC_CLI_DATA_DIR sets as `<data-dir>`: its folder names are the
 * user's. The default one is in the home directory, which the client turns
 * into `~`.
 */
export function withoutDataDir(
  message: string,
  env: Env = process.env,
): string {
  const dir = env.TELEGRAM_SYNC_CLI_DATA_DIR
  if (!dir) return message
  // As given, as join() writes it and absolute; longest first
  const forms = [dir, normalize(dir), resolve(dir)]
    .map((p) => p.replace(/(?<=.)[\\/]+$/, ''))
    .filter((p) => p.length > 1 && p !== '..')
    .sort((a, b) => b.length - a.length)
  if (forms.length === 0) return message
  const alternatives = [...new Set(forms)].map(quoteRe).join('|')
  const re = new RegExp(`(?<![\\w.-])(?:${alternatives})(?![\\w.-])`, 'g')
  return message.replace(re, '<data-dir>')
}

/**
 * A local error (config file, cache database) whose message names no chat,
 * user or query: sent as its type and its message, without account numbers
 * or a data directory the user set, and scrubbed of the home directory and
 * user name by the client. Call it before error().
 */
export function reportLocalError(err: unknown): void {
  if (err instanceof ExitPending) return
  const message = (err as { message?: unknown } | null)?.message
  report(
    typeof message === 'string'
      ? {
          code: errorType(err),
          message: withoutAccountIds(withoutDataDir(message)),
        }
      : errorType(err),
  )
}

/** A thrown error that no command handled, or one the daemon logs, as its type */
export function reportErrorType(err: unknown): void {
  if (err instanceof ExitPending) return
  report(errorType(err))
}

/** True once an exit is under way: output after it prints nothing */
export function isExiting(): boolean {
  return exiting
}

/**
 * Ends the process with `code`. A command exits at once, and its exit hands
 * its events to the copy of tg that sends them. The daemon and debug mode
 * exit once the usage stats in flight are sent, at most 500 ms later: then
 * it returns, and the caller must stop: error() throws ExitPending, which
 * the root command's cleanup holds (endRun).
 */
export function exitAfterFlush(code: number): Promise<never> {
  const pending = new Promise<never>(() => {})
  if (exiting) return pending
  exiting = true
  process.exitCode = code
  if (!tracker) process.exit(code)
  // process.exit used to end the run here. Until it does, an error thrown
  // after this point (ExitPending from a callback, say) changes nothing.
  const hold = () => {}
  process.on('uncaughtException', hold)
  process.on('unhandledRejection', hold)
  void tracker
    .flush(FLUSH_MS)
    .catch(() => {})
    .finally(() => process.exit(code))
  return pending
}

/**
 * The root command's cleanup. An exit under way is held until it happens.
 * With a client sending in this process, a command that returned exits after
 * the flush, so a slow request can't keep tg running; after a thrown error
 * citty prints it and exits with 1.
 */
export async function endRun(): Promise<void> {
  if (exiting) return new Promise<never>(() => {})
  if (!tracker) return
  await tracker.flush(FLUSH_MS).catch(() => {})
  if (completed) process.exit(process.exitCode ?? 0)
}

/** The daemon's exit code, as an error type (DaemonExitCode.NoAccounts → DAEMON_NO_ACCOUNTS) */
export function reportDaemonExit(code: number, name: string | undefined): void {
  if (code === 0) return
  const snake = (name ?? 'Error').replace(/([a-z])([A-Z])/g, '$1_$2')
  report(`DAEMON_${snake.toUpperCase()}`)
}

/** @internal for tests: the events this run would hand over */
export function pendingHandoff(): Handoff | null {
  return handoff
}

/** @internal for tests: forget this process's run */
export function resetTelemetryForTests(): void {
  root = undefined
  tracker = null
  handoff = null
  stateFile = ''
  exiting = false
  errorReported = false
  completed = false
}
