import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
} from '../db'
import { type Account, ErrorCodes } from '../types'
import { error } from './output'

export const ACCOUNT_SELECTOR_DESCRIPTION =
  'Account selector (ID, @username, or label)'

export function resolveAccountSelector(
  selector: string | undefined,
  accountsDb: AccountsDbInterface = defaultAccountsDb,
): number | undefined {
  if (selector === undefined) return undefined

  const trimmed = selector.trim()
  if (!trimmed) {
    error(ErrorCodes.INVALID_ARGS, 'Account selector cannot be empty')
  }

  if (/^\d+$/.test(trimmed)) {
    const id = Number.parseInt(trimmed, 10)
    const account = accountsDb.getById(id)
    if (!account) {
      error(ErrorCodes.ACCOUNT_NOT_FOUND, `Account with ID ${id} not found`)
    }
    return id
  }

  if (trimmed.startsWith('@')) {
    const normalized = trimmed.slice(1)
    const account = accountsDb.getByUsername(normalized)
    if (!account) {
      error(
        ErrorCodes.ACCOUNT_NOT_FOUND,
        `Account with username @${normalized} not found`,
      )
    }
    return account.id
  }

  const labelMatches = accountsDb.getAllByLabel(trimmed)
  if (labelMatches.length === 1) {
    return labelMatches[0]!.id
  }
  if (labelMatches.length > 1) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Multiple accounts match label "${trimmed}". Use an ID or @username instead.`,
      {
        selector: trimmed,
        matches: labelMatches.map((account) => ({
          id: account.id,
          phone: account.phone,
          username: account.username,
          label: account.label,
        })),
      },
    )
  }

  error(
    ErrorCodes.ACCOUNT_NOT_FOUND,
    `Account not found for selector "${trimmed}"`,
  )
}

/**
 * The account a command works on: `--account`, else the active account,
 * else the only one. Each account has its own cache, so a command never
 * guesses between several.
 */
export function resolveAccount(
  selector: string | undefined,
  accountsDb: AccountsDbInterface = defaultAccountsDb,
): Account {
  const selectedId = resolveAccountSelector(selector, accountsDb)
  if (selectedId !== undefined) {
    const selected = accountsDb.getById(selectedId)
    if (selected) return selected
    error(
      ErrorCodes.ACCOUNT_NOT_FOUND,
      `Account with ID ${selectedId} not found`,
    )
  }

  const active = accountsDb.getActive()
  if (active) return active

  const accounts = accountsDb.getAll()
  if (accounts.length === 1) return accounts[0]!

  if (accounts.length === 0) {
    error(
      ErrorCodes.AUTH_REQUIRED,
      'No account found. Please log in first with "tg auth login"',
      undefined,
      'Log in with tg auth login',
    )
  }

  error(
    ErrorCodes.NO_ACTIVE_ACCOUNT,
    `${accounts.length} accounts and none is active`,
    {
      accounts: accounts.map((account) => ({
        id: account.id,
        phone: account.phone,
        username: account.username,
        label: account.label,
      })),
    },
    'Pass --account <id|@username|label> or run tg accounts switch --id <id>',
  )
}
