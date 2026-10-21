/**
 * Account selector tests
 */
import { describe, expect, it } from 'bun:test'

import { createTestDatabase } from '../db'
import { ErrorCodes } from '../types'
import {
  resolveAccount,
  resolveAccountSelector,
} from '../utils/account-selector'

process.env.BUN_ENV = 'test'

describe('resolveAccountSelector', () => {
  it('returns undefined when selector is not provided', () => {
    const result = resolveAccountSelector(
      undefined,
      createTestDatabase().accountsDb,
    )
    expect(result).toBeUndefined()
  })

  it('resolves numeric account IDs', () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({ phone: '+1111111111' })

    const result = resolveAccountSelector(String(account.id), accountsDb)
    expect(result).toBe(account.id)
  })

  it('resolves @username selectors', () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({
      phone: '+1111111111',
      username: 'TestUser',
    })

    const result = resolveAccountSelector('@testuser', accountsDb)
    expect(result).toBe(account.id)
  })

  it('resolves label selectors', () => {
    const { accountsDb } = createTestDatabase()
    const account = accountsDb.create({
      phone: '+1111111111',
      label: 'Work',
    })

    const result = resolveAccountSelector('Work', accountsDb)
    expect(result).toBe(account.id)
  })

  it('throws when label matches multiple accounts', () => {
    const { accountsDb } = createTestDatabase()
    accountsDb.create({ phone: '+1111111111', label: 'Work' })
    accountsDb.create({ phone: '+2222222222', label: 'Work' })

    expect(() => resolveAccountSelector('Work', accountsDb)).toThrow(
      'Multiple accounts match label',
    )
  })

  it('throws when selector does not match any account', () => {
    const { accountsDb } = createTestDatabase()

    try {
      resolveAccountSelector('Missing', accountsDb)
      throw new Error('Expected error')
    } catch (err) {
      const typed = err as Error & { code?: string }
      expect(typed.code).toBe(ErrorCodes.ACCOUNT_NOT_FOUND)
    }
  })
})

/** The error a command would exit with */
function failureOf(run: () => unknown): Error & {
  code?: string
  details?: Record<string, unknown>
} {
  try {
    run()
  } catch (err) {
    return err as Error & { code?: string; details?: Record<string, unknown> }
  }
  throw new Error('Expected an error')
}

describe('resolveAccount', () => {
  it('takes the account --account selects over the active one', () => {
    const { accountsDb } = createTestDatabase()
    accountsDb.create({ phone: '+15550000001', is_active: true })
    const work = accountsDb.create({ phone: '+15550000002', label: 'work' })

    expect(resolveAccount('work', accountsDb).id).toBe(work.id)
    expect(resolveAccount(String(work.id), accountsDb).id).toBe(work.id)
  })

  it('takes the active account without --account', () => {
    const { accountsDb } = createTestDatabase()
    accountsDb.create({ phone: '+15550000001' })
    const active = accountsDb.create({
      phone: '+15550000002',
      is_active: true,
    })

    expect(resolveAccount(undefined, accountsDb).id).toBe(active.id)
  })

  it('takes the only account when none is active', () => {
    const { accountsDb } = createTestDatabase()
    const only = accountsDb.create({ phone: '+15550000001' })

    expect(resolveAccount(undefined, accountsDb).id).toBe(only.id)
  })

  it('asks to log in when there is no account', () => {
    const { accountsDb } = createTestDatabase()

    expect(failureOf(() => resolveAccount(undefined, accountsDb)).code).toBe(
      ErrorCodes.AUTH_REQUIRED,
    )
  })

  it('lists the accounts when several exist and none is active', () => {
    const { accountsDb } = createTestDatabase()
    const first = accountsDb.create({
      phone: '+15550000001',
      username: 'alpha_test',
    })
    const second = accountsDb.create({
      phone: '+15550000002',
      label: 'work',
    })

    const err = failureOf(() => resolveAccount(undefined, accountsDb))

    expect(err.code).toBe(ErrorCodes.NO_ACTIVE_ACCOUNT)
    expect(err.details).toEqual({
      accounts: [
        {
          id: first.id,
          phone: '+15550000001',
          username: 'alpha_test',
          label: null,
        },
        { id: second.id, phone: '+15550000002', username: null, label: 'work' },
      ],
    })
  })

  it('rejects an ID that is not an account', () => {
    const { accountsDb } = createTestDatabase()
    accountsDb.create({ phone: '+15550000001', is_active: true })

    expect(failureOf(() => resolveAccount('3', accountsDb)).code).toBe(
      ErrorCodes.ACCOUNT_NOT_FOUND,
    )
  })
})
