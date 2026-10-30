#!/usr/bin/env bun
/**
 * Telegram Sync CLI - Main Entry Point
 *
 * A comprehensive Telegram Sync CLI client for agent-friendly automation.
 */
import { defineCommand, runMain } from 'citty'
import { accountsCommand } from './commands/accounts'
import { apiCommand } from './commands/api'
import { authCommand } from './commands/auth'
import { chatsCommand } from './commands/chats'
import { configCommand } from './commands/config'
import { contactsCommand } from './commands/contacts'
import { daemonCommand } from './commands/daemon'
import { dbCommand } from './commands/db'
import { mediaCommand } from './commands/media'
import { messagesCommand } from './commands/messages'
import { sendCommand } from './commands/send'
import { skillCommand } from './commands/skill'
import { sqlCommand } from './commands/sql'
import { statusCommand } from './commands/status'
import { telemetryCommand } from './commands/telemetry'
import { meCommand, userCommand } from './commands/user'
import {
  ConfigError,
  ConfigReadError,
  syncActiveAccountFromConfig,
} from './config'
import {
  endRun,
  instrumentCommands,
  reportErrorType,
  reportLocalError,
  startTelemetry,
} from './telemetry'
import { EVENTS_ENV } from './telemetry/background'
import { sendHandoff } from './telemetry/send'
import { ErrorCodes, type OutputFormat } from './types'
import { error, getOutputFormat, setOutputFormat } from './utils/output'
import { VERSION } from './version'

const main = defineCommand({
  meta: {
    name: 'tg',
    version: VERSION,
    description: 'Telegram Sync CLI - Agent-friendly Telegram client',
  },
  args: {
    format: {
      type: 'enum',
      alias: 'f',
      description: 'Output format: json, pretty, or quiet',
      options: ['json', 'pretty', 'quiet'],
      default: 'json',
    },
    verbose: {
      type: 'boolean',
      alias: 'v',
      description: 'Enable verbose output',
      default: false,
    },
    quiet: {
      type: 'boolean',
      alias: 'q',
      description: 'Minimal output (errors only)',
      default: false,
    },
  },
  async setup({ args, rawArgs }) {
    // Set output format
    const format = args.format as OutputFormat
    if (format === 'json' || format === 'pretty' || format === 'quiet') {
      setOutputFormat(format)
    }

    if (args.quiet) {
      setOutputFormat('quiet')
    }

    // Set verbose flag
    if (args.verbose) {
      process.env.VERBOSE = '1'
    }

    // The usage stats notice once, then app_started and the command path
    startTelemetry(rawArgs, { quiet: getOutputFormat() === 'quiet' })

    // As citty does, skip the value of -f/--format: in `tg -f json skill`
    // the subcommand is skill, not json
    const subCommand = rawArgs.find(
      (arg, i) =>
        !arg.startsWith('-') &&
        rawArgs[i - 1] !== '-f' &&
        rawArgs[i - 1] !== '--format',
    )
    // tg config has to repair an invalid file. tg skill and tg telemetry
    // read no key, and tg daemon only cache.retention.*, leniently: a
    // supervised daemon must not stop over a typo there, silently under its
    // own -q (which sets ours)
    if (
      subCommand === 'config' ||
      subCommand === 'skill' ||
      subCommand === 'telemetry' ||
      subCommand === 'daemon'
    ) {
      return
    }

    try {
      await syncActiveAccountFromConfig()
    } catch (err) {
      if (err instanceof ConfigError || err instanceof ConfigReadError) {
        reportLocalError(err)
      }
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
      }
      if (err instanceof ConfigReadError) {
        error(
          ErrorCodes.GENERAL_ERROR,
          err.message,
          { path: err.path },
          'Make config.json readable or remove it',
        )
      }
      reportErrorType(err)
      throw err
    }
  },
  // Waits for usage stats in flight before the exit
  cleanup: endRun,
  subCommands: {
    auth: authCommand,
    accounts: accountsCommand,
    contacts: contactsCommand,
    config: configCommand,
    chats: chatsCommand,
    send: sendCommand,
    daemon: daemonCommand,
    db: dbCommand,
    messages: messagesCommand,
    media: mediaCommand,
    api: apiCommand,
    me: meCommand,
    user: userCommand,
    status: statusCommand,
    skill: skillCommand,
    sql: sqlCommand,
    telemetry: telemetryCommand,
  },
})

// The compiled binary is also the copy of tg that sends a run's usage stats
if (process.env[EVENTS_ENV] !== undefined) {
  void sendHandoff(process.env[EVENTS_ENV])
} else {
  instrumentCommands(main)
  runMain(main)
}
