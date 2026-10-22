/**
 * Account management commands
 */
import { defineCommand } from 'citty'

import {
  ConfigError,
  getConfigPath,
  getConfigValue,
  setConfigValue,
} from '../config'
import { accountsDb } from '../db'
import { ErrorCodes } from '../types'
import { settleCacheLayoutBeforeAccountChange } from '../utils/account-cache'
import { error, success } from '../utils/output'

/**
 * List all accounts
 */
export const listAccountsCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List all configured accounts',
  },
  async run() {
    const accounts = accountsDb.getAll()

    if (accounts.length === 0) {
      success({
        accounts: [],
        message: 'No accounts configured. Use "tg auth login" to add one.',
      })
      return
    }

    success({
      accounts: accounts.map((a) => ({
        id: a.id,
        phone: a.phone,
        name: a.name,
        username: a.username,
        label: a.label,
        isActive: a.is_active === 1,
        createdAt: a.created_at,
      })),
      total: accounts.length,
    })
  },
})

/**
 * Switch active account
 */
export const switchAccountCommand = defineCommand({
  meta: {
    name: 'switch',
    description: 'Switch the active account',
  },
  args: {
    id: {
      type: 'string',
      description: 'Account ID to switch to',
      required: true,
    },
  },
  async run({ args }) {
    const accountId = parseInt(args.id, 10)
    const account = accountsDb.getById(accountId)

    if (!account) {
      error(
        ErrorCodes.ACCOUNT_NOT_FOUND,
        `Account with ID ${accountId} not found`,
      )
    }

    // Every start applies activeAccount from config.json again (src/index.ts
    // setup), so keep it in step or the switch lasts one command (#61)
    try {
      const pinned = await getConfigValue('activeAccount')
      if (pinned !== undefined && pinned !== accountId) {
        await setConfigValue('activeAccount', accountId)
      }
    } catch (err) {
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
      }
      error(
        ErrorCodes.GENERAL_ERROR,
        `Could not write activeAccount to ${getConfigPath()}: ${(err as Error).message}`,
        { path: getConfigPath() },
        'Make config.json writable or remove activeAccount from it',
      )
    }
    accountsDb.setActive(accountId)

    success({
      message: `Switched to account ${accountId}`,
      account: {
        id: account.id,
        phone: account.phone,
        name: account.name,
        username: account.username,
        label: account.label,
      },
    })
  },
})

/**
 * Remove an account
 */
export const removeAccountCommand = defineCommand({
  meta: {
    name: 'remove',
    description: 'Remove an account',
  },
  args: {
    id: {
      type: 'string',
      description: 'Account ID to remove',
      required: true,
    },
  },
  async run({ args }) {
    const accountId = parseInt(args.id, 10)
    const account = accountsDb.getById(accountId)

    if (!account) {
      error(
        ErrorCodes.ACCOUNT_NOT_FOUND,
        `Account with ID ${accountId} not found`,
      )
    }

    settleCacheLayoutBeforeAccountChange()
    accountsDb.delete(accountId)

    success({
      message: `Removed account ${accountId}`,
      removedAccount: {
        id: account.id,
        phone: account.phone,
        username: account.username,
        label: account.label,
      },
    })
  },
})

/**
 * Show account info
 */
export const infoAccountCommand = defineCommand({
  meta: {
    name: 'info',
    description: 'Show detailed account information',
  },
  args: {
    id: {
      type: 'string',
      description: 'Account ID (uses active account if not specified)',
    },
  },
  async run({ args }) {
    const accountId = args.id ? parseInt(args.id, 10) : undefined
    const account = accountId
      ? accountsDb.getById(accountId)
      : accountsDb.getActive()

    if (!account) {
      error(ErrorCodes.ACCOUNT_NOT_FOUND, 'No account found')
    }

    success({
      account: {
        id: account.id,
        phone: account.phone,
        name: account.name,
        username: account.username,
        label: account.label,
        isActive: account.is_active === 1,
        createdAt: account.created_at,
        updatedAt: account.updated_at,
      },
    })
  },
})

/**
 * Accounts subcommand group
 */
export const accountsCommand = defineCommand({
  meta: {
    name: 'accounts',
    description: 'Account management commands',
  },
  subCommands: {
    list: listAccountsCommand,
    switch: switchAccountCommand,
    remove: removeAccountCommand,
    info: infoAccountCommand,
  },
})
