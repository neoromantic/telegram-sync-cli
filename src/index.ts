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
import { messagesCommand } from './commands/messages'
import { sendCommand } from './commands/send'
import { skillCommand } from './commands/skill'
import { sqlCommand } from './commands/sql'
import { statusCommand } from './commands/status'
import { meCommand, userCommand } from './commands/user'
import {
  ConfigError,
  ConfigReadError,
  syncActiveAccountFromConfig,
} from './config'
import { ErrorCodes, type OutputFormat } from './types'
import { error, setOutputFormat } from './utils/output'
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

    // As citty does, skip the value of -f/--format: in `tg -f json skill`
    // the subcommand is skill, not json
    const subCommand = rawArgs.find(
      (arg, i) =>
        !arg.startsWith('-') &&
        rawArgs[i - 1] !== '-f' &&
        rawArgs[i - 1] !== '--format',
    )
    // tg config has to repair an invalid file. tg skill and tg daemon read
    // neither activeAccount nor the TTLs, and a supervised daemon must not
    // stop over a typo there, silently under its own -q (which sets ours)
    if (
      subCommand === 'config' ||
      subCommand === 'skill' ||
      subCommand === 'daemon'
    ) {
      return
    }

    try {
      await syncActiveAccountFromConfig()
    } catch (err) {
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
      throw err
    }
  },
  subCommands: {
    auth: authCommand,
    accounts: accountsCommand,
    contacts: contactsCommand,
    config: configCommand,
    chats: chatsCommand,
    send: sendCommand,
    daemon: daemonCommand,
    messages: messagesCommand,
    api: apiCommand,
    me: meCommand,
    user: userCommand,
    status: statusCommand,
    skill: skillCommand,
    sql: sqlCommand,
  },
})

runMain(main)
