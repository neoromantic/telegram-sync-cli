/**
 * Usage stats in the background. A command keeps its events, and as it
 * exits it hands them to a detached copy of tg (send.ts) that sends them and
 * exits: the command never waits for the network. The copy starts only when
 * there is something to send.
 */
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Channel } from './client'

/** The events of a run, as JSON; set only for the copy of tg that sends them */
export const EVENTS_ENV = 'TELEGRAM_SYNC_CLI_TELEMETRY_EVENTS'

/** An error as report() passes it: its type, or a local error's type and message */
export type ErrorReport = string | { code: string; message: string }

/** A call on the client, replayed by the copy that sends */
export type Call = ['started'] | ['feature', string] | ['error', ErrorReport]

/** What the copy of tg needs to send a run's events as the run would have */
export interface Handoff {
  channel: Channel
  /** stdin or stderr was a terminal: the client's interactive mode */
  tty: boolean
  calls: Call[]
}

type Env = Record<string, string | undefined>

/**
 * The variables by which the client tells that an AI agent runs tg: a copy
 * of detectAgent's in client.ts (devkit's templates/telemetry/), kept in step
 * with it by hand
 */
const AGENT_VARS = [
  'AI_AGENT',
  'CLAUDECODE',
  'CODEX_SANDBOX',
  'CODEX_THREAD_ID',
  'CURSOR_AGENT',
  'GEMINI_CLI',
]

/** A compiled binary runs its modules from Bun's embedded file system */
export function isCompiled(modulePath: string = import.meta.path): boolean {
  return modulePath.includes('$bunfs') || modulePath.includes('~BUN')
}

/** The keys under which the client counts a call's event once a day */
export function dailyKey(call: Call): string {
  const [name, arg] = call
  if (name === 'started') return 'app_started'
  if (name === 'feature') return `feature_used:${arg}`
  const type = typeof arg === 'string' ? arg : arg.code
  return `error_occurred:${[...type].slice(0, 100).join('') || 'Error'}`
}

/**
 * True when the client would send none of `calls`: a run from a script (no
 * terminal, no AI agent) sends each event once a UTC day, and telemetry.json
 * says this install sent all of them today. It only saves starting a copy
 * that would find nothing to send; any doubt starts it.
 */
export function sentToday(
  stateFile: string,
  handoff: Handoff,
  env: Env = process.env,
  now: Date = new Date(),
): boolean {
  if (handoff.tty) return false
  if (AGENT_VARS.some((name) => (env[name] ?? '').trim() !== '')) return false
  try {
    const state = JSON.parse(readFileSync(stateFile, 'utf8')) as {
      installed?: unknown
      daily?: Record<string, unknown>
    }
    const day = now.toISOString().slice(0, 10)
    return (
      state.installed === true &&
      handoff.calls.every((call) => state.daily?.[dailyKey(call)] === day)
    )
  } catch {
    return false
  }
}

/**
 * The environment of the copy that sends `handoff`. It runs in another
 * folder, so a data directory given as a relative path is made absolute.
 */
export function senderEnv(handoff: Handoff, env: Env = process.env): Env {
  const dataDir = env.TELEGRAM_SYNC_CLI_DATA_DIR
  return {
    ...env,
    ...(dataDir && { TELEGRAM_SYNC_CLI_DATA_DIR: resolve(dataDir) }),
    [EVENTS_ENV]: JSON.stringify(handoff),
  }
}

/**
 * Starts the copy of tg that sends `handoff`, detached and with no stdio,
 * so this process can exit at once: the binary itself, or Bun with send.ts
 * for the npm package and a checkout.
 */
export function sendInBackground(handoff: Handoff, env: Env = process.env) {
  const command = isCompiled()
    ? [process.execPath]
    : [process.execPath, '--no-env-file', join(import.meta.dir, 'send.ts')]
  Bun.spawn(command, {
    env: senderEnv(handoff, env),
    // Not the user's folder: Windows keeps a process's folder from deletion
    cwd: tmpdir(),
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
    windowsHide: true,
  }).unref()
}
