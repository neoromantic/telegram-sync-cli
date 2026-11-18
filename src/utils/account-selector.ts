import {
  type AccountsDbInterface,
  accountsDb as defaultAccountsDb,
} from '../db'
import { type Account, ErrorCodes } from '../types'
import { error } from './output'

export const ACCOUNT_SELECTOR_DESCRIPTION =
  'Account selector (ID, @username, or label)'

/** The suggestion of an ACCOUNT_NOT_FOUND error for --account */
export const ACCOUNT_NOT_FOUND_SUGGESTION =
  'Run tg accounts list to see the accounts, then pass an ID, @username or label to --account'

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
      error(
        ErrorCodes.ACCOUNT_NOT_FOUND,
        `Account with ID ${id} not found`,
        undefined,
        ACCOUNT_NOT_FOUND_SUGGESTION,
      )
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
        undefined,
        ACCOUNT_NOT_FOUND_SUGGESTION,
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
    undefined,
    ACCOUNT_NOT_FOUND_SUGGESTION,
  )
}

/** The account without --account: the active one, else the only one, else null */
export function findDefaultAccount(
  accountsDb: AccountsDbInterface = defaultAccountsDb,
): { account: Account | null; accounts: Account[] } {
  const accounts = accountsDb.getAll()
  const account =
    accountsDb.getActive() ?? (accounts.length === 1 ? accounts[0]! : null)
  return { account, accounts }
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
      undefined,
      ACCOUNT_NOT_FOUND_SUGGESTION,
    )
  }

  const { account, accounts } = findDefaultAccount(accountsDb)
  if (account) return account

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
