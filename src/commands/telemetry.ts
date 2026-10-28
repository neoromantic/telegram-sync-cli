/**
 * Telemetry command - usage stats status and the off switch
 *
 * Usage:
 *   tg telemetry status [--json]   Whether usage stats are on, and why
 *   tg telemetry on                Turn them on (marks the notice as seen)
 *   tg telemetry off               Turn them off and forget the install ID
 */
import { defineCommand } from 'citty'
import {
  createTgTelemetry,
  DETAILS_URL,
  OFF_COMMAND,
  telemetryStatus,
} from '../telemetry'
import { ErrorCodes } from '../types'
import { error, getOutputFormat, success } from '../utils/output'

const REASONS: Record<string, string> = {
  'no-endpoint':
    'a source checkout or a build without an endpoint sends nothing',
  'do-not-track': 'DO_NOT_TRACK is set',
  env: 'TELEGRAM_SYNC_CLI_TELEMETRY is set',
  ci: 'running in CI',
  test: 'running in tests',
  'dev-version': 'a development version',
  state: 'tg telemetry on/off',
  default: 'the default',
}

function printPretty(status: ReturnType<typeof telemetryStatus>): void {
  const state = status.debug
    ? 'debug, printed to stderr and not sent'
    : status.enabled
      ? 'on'
      : 'off'
  console.log(
    [
      `Usage stats: ${state} (${REASONS[status.reason] ?? status.reason})`,
      `Install ID:  ${status.id ?? 'none'}`,
      `State file:  ${status.stateFile}`,
      `Channel:     ${status.channel}`,
      `Turn off:    ${OFF_COMMAND} or DO_NOT_TRACK=1`,
      `Details:     ${DETAILS_URL}`,
    ].join('\n'),
  )
}

const statusCommand = defineCommand({
  meta: {
    name: 'status',
    description:
      'Show whether usage stats are on, what decided it, the install ID and the state file',
  },
  args: {
    json: {
      type: 'boolean',
      description: 'Force JSON output',
      alias: 'j',
      default: false,
    },
  },
  async run({ args }) {
    const status = telemetryStatus()
    if (!args.json && getOutputFormat() === 'pretty') {
      printPretty(status)
      return
    }
    success(status)
  },
})

function switchCommand(on: boolean) {
  return defineCommand({
    meta: {
      name: on ? 'on' : 'off',
      description: on
        ? 'Turn usage stats on'
        : 'Turn usage stats off and forget the install ID',
    },
    async run() {
      const t = createTgTelemetry()
      if (!t.setEnabled(on)) {
        const { stateFile } = t.status()
        error(
          ErrorCodes.GENERAL_ERROR,
          `Could not write ${stateFile}`,
          { path: stateFile },
          'Make the data directory writable, or set DO_NOT_TRACK=1',
        )
      }
      success(telemetryStatus(t))
    },
  })
}

export const telemetryCommand = defineCommand({
  meta: {
    name: 'telemetry',
    description: `Usage stats: status, on, off (details: ${DETAILS_URL})`,
  },
  subCommands: {
    status: statusCommand,
    on: switchCommand(true),
    off: switchCommand(false),
  },
})
