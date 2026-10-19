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
import { ConfigError, syncActiveAccountFromConfig } from './config'
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
      return
    }

    // Set verbose flag
    if (args.verbose) {
      process.env.VERBOSE = '1'
    }

    const subCommand = rawArgs.find((arg) => !arg.startsWith('-'))
    if (subCommand === 'config' || subCommand === 'skill') return

    try {
      await syncActiveAccountFromConfig()
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
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
