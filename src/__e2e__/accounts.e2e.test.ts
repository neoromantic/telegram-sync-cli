/**
 * E2E tests for accounts commands
 *
 * Tests accounts list, switch, remove, and info commands
 * using an isolated database environment.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { runCliFailure, runCliSuccess } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

describe('E2E: Accounts Commands', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('accounts')
    env.initDatabase()
  })

  afterEach(() => {
    env.cleanup()
  })

  describe('accounts list', () => {
    it('should return empty list when no accounts', async () => {
      const result = await runCliSuccess(
        ['accounts', 'list'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: { accounts: unknown[]; message: string }
      }
      expect(response.success).toBe(true)
      expect(response.data.accounts).toEqual([])
      expect(response.data.message).toContain('No accounts configured')
    })

    it('should list all accounts', async () => {
      env.seedAccounts([
        { phone: '+1111111111', name: 'Account 1', is_active: true },
        { phone: '+2222222222', name: 'Account 2', is_active: false },
        { phone: '+3333333333', is_active: false },
      ])

      const result = await runCliSuccess(
        ['accounts', 'list'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          accounts: Array<{
            id: number
            phone: string
            name: string | null
            isActive: boolean
          }>
          total: number
        }
      }
      expect(response.success).toBe(true)
      expect(response.data.accounts).toHaveLength(3)
      expect(response.data.total).toBe(3)

      // Check first account
      const account1 = response.data.accounts[0]!
      expect(account1.id).toBe(1)
      expect(account1.phone).toBe('+1111111111')
      expect(account1.name).toBe('Account 1')
      expect(account1.isActive).toBe(true)

      // Check second account
      const account2 = response.data.accounts[1]!
      expect(account2.id).toBe(2)
      expect(account2.isActive).toBe(false)

      // Check third account (no name)
      const account3 = response.data.accounts[2]!
      expect(account3.name).toBeNull()
    })
  })

  describe('accounts switch', () => {
    beforeEach(() => {
      env.seedAccounts([
        { phone: '+1111111111', name: 'Account 1', is_active: true },
        { phone: '+2222222222', name: 'Account 2', is_active: false },
      ])
    })

    it('should switch to existing account', async () => {
      const result = await runCliSuccess(
        ['accounts', 'switch', '--id', '2'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          message: string
          account: { id: number; phone: string; name: string }
        }
      }
      expect(response.success).toBe(true)
      expect(response.data.message).toContain('Switched to account 2')
      expect(response.data.account.id).toBe(2)
      expect(response.data.account.phone).toBe('+2222222222')
    })

    it('should fail for non-existent account', async () => {
      const result = await runCliFailure(
        ['accounts', 'switch', '--id', '9999'],
        6,
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        error: {
          code: string
          message: string
          suggestion: string
          retryable: boolean
        }
      }
      expect(response.success).toBe(false)
      expect(response.error.code).toBe('ACCOUNT_NOT_FOUND')
      expect(response.error.message).toContain('9999')
      expect(response.error.suggestion).toBe(
        'Run tg accounts list to see the account IDs, then pass one to --id',
      )
      expect(response.error.retryable).toBe(false)
    })

    it('should verify account is now active after switch', async () => {
      // Switch to account 2
      await runCliSuccess(
        ['accounts', 'switch', '--id', '2'],
        env.getCliOptions(),
      )

      // Verify via info command
      const result = await runCliSuccess(
        ['accounts', 'info'],
        env.getCliOptions(),
      )

      const response = result.json as {
        data: { account: { id: number; isActive: boolean } }
      }
      expect(response.data.account.id).toBe(2)
      expect(response.data.account.isActive).toBe(true)
    })
  })

  describe('accounts remove', () => {
    beforeEach(() => {
      env.seedAccounts([
        { phone: '+1111111111', name: 'Account 1', is_active: true },
        { phone: '+2222222222', name: 'Account 2', is_active: false },
      ])
    })

    it('should remove existing account', async () => {
      const result = await runCliSuccess(
        ['accounts', 'remove', '--id', '2'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          message: string
          removedAccount: { id: number; phone: string }
        }
      }
      expect(response.success).toBe(true)
      expect(response.data.message).toContain('Removed account 2')
      expect(response.data.removedAccount.id).toBe(2)
    })

    it('should fail for non-existent account', async () => {
      const result = await runCliFailure(
        ['accounts', 'remove', '--id', '9999'],
        6,
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(6)
    })

    it('should verify account is gone after removal', async () => {
      // Remove account 2
      await runCliSuccess(
        ['accounts', 'remove', '--id', '2'],
        env.getCliOptions(),
      )

      // Verify via list
      const result = await runCliSuccess(
        ['accounts', 'list'],
        env.getCliOptions(),
      )

      const response = result.json as {
        data: { accounts: Array<{ id: number }>; total: number }
      }
      expect(response.data.accounts).toHaveLength(1)
      expect(response.data.total).toBe(1)
      const remainingAccount = response.data.accounts[0]
      expect(remainingAccount?.id).toBe(1)
    })
  })

  describe('accounts info', () => {
    beforeEach(() => {
      env.seedAccounts([
        { phone: '+1111111111', name: 'Active Account', is_active: true },
        { phone: '+2222222222', name: 'Inactive Account', is_active: false },
      ])
    })

    it('should show active account info when no ID given', async () => {
      const result = await runCliSuccess(
        ['accounts', 'info'],
        env.getCliOptions(),
      )

      const response = result.json as {
        success: boolean
        data: {
          account: {
            id: number
            phone: string
            name: string
            isActive: boolean
          }
        }
      }
      expect(response.success).toBe(true)
      expect(response.data.account.id).toBe(1)
      expect(response.data.account.phone).toBe('+1111111111')
      expect(response.data.account.name).toBe('Active Account')
      expect(response.data.account.isActive).toBe(true)
    })

    it('should show specific account info when ID given', async () => {
      const result = await runCliSuccess(
        ['accounts', 'info', '--id', '2'],
        env.getCliOptions(),
      )

      const response = result.json as {
        data: { account: { id: number; name: string } }
      }
      expect(response.data.account.id).toBe(2)
      expect(response.data.account.name).toBe('Inactive Account')
    })

    it('should fail when no active account and no ID given', async () => {
      // Create fresh environment with no active accounts
      env.cleanup()
      env = createTestEnvironment('accounts-no-active')
      env.initDatabase()
      env.seedAccounts([
        { phone: '+1111111111', is_active: false },
        { phone: '+2222222222', is_active: false },
      ])

      const result = await runCliFailure(
        ['accounts', 'info'],
        6,
        env.getCliOptions(),
      )

      expect(result.exitCode).toBe(6)
      expect(
        (result.json as { error: { suggestion?: string } }).error.suggestion,
      ).toBe(
        'Run tg accounts list to see the account IDs, then pass one to --id',
      )
    })

    it('suggests nothing when there is no account at all', async () => {
      env.cleanup()
      env = createTestEnvironment('accounts-none')
      env.initDatabase()

      const result = await runCliFailure(
        ['accounts', 'info'],
        6,
        env.getCliOptions(),
      )

      expect(result.json).toEqual({
        success: false,
        error: {
          code: 'ACCOUNT_NOT_FOUND',
          message: 'No account found',
          retryable: false,
        },
      })
    })
  })
})
