/**
 * Authentication commands tests
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelegramClient } from '@mtcute/bun'
import {
  type AuthDependencies,
  getAuthStatus,
  getDefaultDependencies,
  loginWithPhone,
  loginWithQr,
  logout,
  type QrCodeGenerator,
} from '../commands/auth'
import { syncActiveAccountFromConfig } from '../config'
import { type AccountsDbInterface, createTestDatabase } from '../db'
import type { Account } from '../types'

// Set test environment
process.env.BUN_ENV = 'test'

const PHONE = '+15550000002'

describe('Authentication Commands', () => {
  let accountsDb: AccountsDbInterface
  let mockClients: Map<number, TelegramClient>
  let deps: AuthDependencies

  type SignInQrOptions = {
    onUrlUpdated?: (url: string, expires: Date) => void
    onQrScanned?: () => void
  }

  type MockAuthClient = Pick<
    TelegramClient,
    'start' | 'getMe' | 'signInQr' | 'call' | 'destroy'
  >

  type UserResult = Awaited<ReturnType<TelegramClient['getMe']>>

  const createUser = (overrides: Partial<UserResult> = {}): UserResult =>
    ({
      id: 123,
      firstName: 'Test',
      lastName: 'User',
      username: 'testuser',
      ...overrides,
    }) as UserResult

  const createMockClient = (
    overrides: Partial<MockAuthClient> = {},
  ): TelegramClient => {
    const client = {
      start: mock(() =>
        Promise.resolve(
          createUser({
            id: 123,
            firstName: 'Test',
            lastName: 'User',
            username: 'testuser',
          }),
        ),
      ),
      getMe: mock(() =>
        Promise.resolve(
          createUser({
            id: 123,
            firstName: 'Test',
            username: 'testuser',
          }),
        ),
      ),
      signInQr: mock((_options: SignInQrOptions) =>
        Promise.resolve(
          createUser({
            id: 456,
            firstName: 'QR',
            lastName: 'User',
            username: 'qruser',
          }),
        ),
      ),
      call: mock(() => Promise.resolve({})),
      destroy: mock(() => Promise.resolve()),
      ...overrides,
    } satisfies MockAuthClient

    return client as TelegramClient
  }

  beforeEach(() => {
    const testDb = createTestDatabase()
    accountsDb = testDb.accountsDb
    mockClients = new Map()

    // Create mock dependencies
    deps = {
      accountsDb,
      createClient: mock((accountId: number) => {
        const client = createMockClient({
          signInQr: mock((options: SignInQrOptions) => {
            // Simulate QR code flow
            if (options.onUrlUpdated) {
              options.onUrlUpdated('tg://login?token=abc', new Date())
            }
            if (options.onQrScanned) {
              options.onQrScanned()
            }
            return Promise.resolve(
              createUser({
                id: 456,
                firstName: 'QR',
                lastName: 'User',
                username: 'qruser',
              }),
            )
          }),
        })
        mockClients.set(accountId, client)
        return client
      }),
      getClient: mock((accountId: number) => {
        let client = mockClients.get(accountId)
        if (!client) {
          client = createMockClient()
          mockClients.set(accountId, client)
        }
        return client
      }),
      isAuthorized: mock(() => Promise.resolve(true)),
      prompt: mock(() => Promise.resolve('123456')),
      promptPassword: mock(() => Promise.resolve('password123')),
      keepActiveAccountInConfig: mock(() => Promise.resolve()),
    }
  })

  describe('loginWithPhone', () => {
    it('should create new account and login', async () => {
      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(true)
      expect(result.account).toBeDefined()
      expect(result.account?.phone).toBe('+1234567890')
      expect(result.account?.name).toBe('Test')
      expect(result.account?.username).toBe('testuser')
    })

    it('should use existing account if phone exists', async () => {
      const existing = accountsDb.create({
        phone: '+1234567890',
        name: 'Existing',
      })

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(true)
      expect(result.account?.id).toBe(existing.id)
    })

    it('should set existing account as active when relogging', async () => {
      accountsDb.create({ phone: '+1111111111', is_active: true })
      accountsDb.create({ phone: '+2222222222', is_active: false })

      // Re-login to existing account should set it as active
      await loginWithPhone('+2222222222', deps)

      const active = accountsDb.getActive()
      expect(active?.phone).toBe('+2222222222')
    })

    it('should update account name after login', async () => {
      await loginWithPhone('+1234567890', deps)

      const account = accountsDb.getByPhone('+1234567890')
      expect(account?.name).toBe('Test User')
    })

    it('should persist username and label on login', async () => {
      await loginWithPhone('+1234567890', deps, { label: 'Work' })

      const account = accountsDb.getByPhone('+1234567890')
      expect(account?.username).toBe('testuser')
      expect(account?.label).toBe('Work')
    })

    it('should return error on login failure', async () => {
      deps.createClient = mock(() =>
        createMockClient({
          start: mock(() => Promise.reject(new Error('Invalid phone'))),
        }),
      )

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid phone')
    })

    it('should handle non-Error exceptions', async () => {
      deps.createClient = mock(() =>
        createMockClient({
          start: mock(() => Promise.reject('string error')),
        }),
      )

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Unknown error')
    })

    it('should handle user without lastName', async () => {
      deps.createClient = mock((_accountId: number) =>
        createMockClient({
          start: mock(() =>
            Promise.resolve(
              createUser({
                id: 123,
                firstName: 'Single',
                lastName: null,
                username: 'single',
              }),
            ),
          ),
        }),
      )

      const result = await loginWithPhone('+1234567890', deps)

      expect(result.success).toBe(true)
      const account = accountsDb.getByPhone('+1234567890')
      expect(account?.name).toBe('Single')
    })

    it('merges duplicate user_id accounts and keeps existing', async () => {
      // Use a lightweight in-memory accounts DB to avoid unique constraint conflicts
      const accounts = new Map<number, Account>()
      let nextId = 1
      type CreateAccountInput = Parameters<AccountsDbInterface['create']>[0]
      type UpdateAccountInput = Parameters<AccountsDbInterface['update']>[1]
      const inMemoryDb: AccountsDbInterface = {
        getAll: () => Array.from(accounts.values()),
        getById: (id: number) => accounts.get(id) ?? null,
        getByPhone: (phone: string) =>
          Array.from(accounts.values()).find((acc) => acc.phone === phone) ??
          null,
        getByUserId: (userId: number) =>
          Array.from(accounts.values()).find((acc) => acc.user_id === userId) ??
          null,
        getByUsername: (username: string) =>
          Array.from(accounts.values()).find(
            (acc) => acc.username === username,
          ) ?? null,
        getAllByLabel: (label: string) =>
          Array.from(accounts.values()).filter((acc) => acc.label === label),
        getActive: () =>
          Array.from(accounts.values()).find((acc) => acc.is_active === 1) ??
          null,
        create: (data: CreateAccountInput) => {
          const account: Account = {
            id: nextId++,
            phone: data.phone,
            user_id: data.user_id ?? null,
            name: data.name ?? null,
            username: data.username ?? null,
            label: data.label ?? null,
            session_data: data.session_data ?? '',
            is_active: data.is_active ? 1 : 0,
            created_at: '',
            updated_at: '',
          }
          accounts.set(account.id, account)
          return account
        },
        update: (id: number, data: UpdateAccountInput) => {
          const current = accounts.get(id)
          if (!current) return null
          const updated: Account = {
            ...current,
            phone: data.phone ?? current.phone,
            user_id:
              data.user_id !== undefined ? data.user_id : current.user_id,
            name: data.name ?? current.name,
            username:
              data.username !== undefined ? data.username : current.username,
            label: data.label !== undefined ? data.label : current.label,
          }
          accounts.set(id, updated)
          return updated
        },
        updateSession: () => {},
        setActive: (id: number) => {
          for (const acc of accounts.values()) {
            acc.is_active = acc.id === id ? 1 : 0
          }
        },
        delete: (id: number) => accounts.delete(id),
        count: () => accounts.size,
      }

      const existing = inMemoryDb.create({
        phone: 'user:123',
        user_id: 123,
        name: 'Old',
      })

      deps.accountsDb = inMemoryDb

      deps.createClient = mock((_accountId: number) =>
        createMockClient({
          start: mock(() =>
            Promise.resolve(
              createUser({
                id: 123,
                firstName: 'Merged',
                lastName: 'User',
                username: 'merged',
              }),
            ),
          ),
        }),
      )

      const result = await loginWithPhone('+15550001111', deps)

      expect(result.success).toBe(true)
      expect(result.account?.id).toBe(existing.id)
      expect(inMemoryDb.count()).toBe(1)
      expect(inMemoryDb.getById(existing.id)?.phone).toBe('+15550001111')
      expect(deps.keepActiveAccountInConfig).toHaveBeenCalledWith(existing.id)
      expect(inMemoryDb.getActive()?.id).toBe(existing.id)
    })

    it('closes client after successful login', async () => {
      const client = createMockClient({
        start: mock(() =>
          Promise.resolve(
            createUser({
              id: 321,
              firstName: 'Close',
              lastName: 'Test',
              username: 'closer',
            }),
          ),
        ),
      })

      deps.createClient = mock(() => client)

      await loginWithPhone('+19998887777', deps)

      expect(client.destroy).toHaveBeenCalled()
    })
  })

  describe('loginWithQr', () => {
    let mockQrGenerator: QrCodeGenerator

    beforeEach(() => {
      mockQrGenerator = {
        generate: mock((_url, _options, callback) => {
          callback('QR_CODE_HERE')
        }),
      }
      deps.qrGenerator = mockQrGenerator
    })

    it('should create new account and login via QR', async () => {
      const result = await loginWithQr('test_account', deps)

      expect(result.success).toBe(true)
      expect(result.account).toBeDefined()
      expect(result.account?.name).toBe('QR')
      expect(result.account?.username).toBe('qruser')
      expect(result.account?.userId).toBe(456)
    })

    it('should generate default account name if not provided', async () => {
      const result = await loginWithQr(undefined, deps)

      expect(result.success).toBe(true)
      // After successful login, account phone is updated to user:userId
      const accounts = accountsDb.getAll()
      expect(accounts[0]?.phone).toBe('user:456')
    })

    it('should update phone with user ID after login', async () => {
      await loginWithQr('test', deps)

      const account = accountsDb.getByPhone('user:456')
      expect(account).toBeDefined()
    })

    it('should delete account on failure', async () => {
      deps.createClient = mock(() =>
        createMockClient({
          signInQr: mock(() => Promise.reject(new Error('QR expired'))),
        }),
      )

      const result = await loginWithQr('test', deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('QR expired')
      expect(accountsDb.count()).toBe(0)
    })

    it('should call QR generator', async () => {
      await loginWithQr('test', deps)

      expect(mockQrGenerator.generate).toHaveBeenCalled()
    })

    it('merges duplicate user_id accounts and keeps existing', async () => {
      const existing = accountsDb.create({
        phone: '+19990000000',
        user_id: 456,
        name: 'Existing',
      })

      const result = await loginWithQr('dup', deps)

      expect(result.success).toBe(true)
      expect(result.account?.id).toBe(existing.id)
      expect(accountsDb.count()).toBe(1)
      expect(accountsDb.getById(existing.id)?.phone).toBe('+19990000000')
    })
  })

  /**
   * The command after a login has to use the account it logged in to (#62):
   * in data.db, and in config.json when activeAccount is set there, as every
   * start applies it. Account 1 is active at the start of each test; the
   * phone login signs in user 123 and the QR login user 456, so both add
   * account 2. The tests use tg's own hook on a data dir of their own.
   */
  describe('the account a login makes active', () => {
    const isRoot = process.getuid?.() === 0
    const logins = [
      ['tg auth login', (d: AuthDependencies) => loginWithPhone(PHONE, d)],
      ['tg auth login-qr', (d: AuthDependencies) => loginWithQr('Second', d)],
    ] as const

    let dataDir: string
    let savedDataDir: string | undefined

    const configPath = () => join(dataDir, 'config.json')
    const writeConfig = (text: string) => writeFileSync(configPath(), text)
    const readConfig = () => readFileSync(configPath(), 'utf8')

    const activeIds = () =>
      accountsDb
        .getAll()
        .filter((account) => account.is_active === 1)
        .map((account) => account.id)

    /** What the next command's start does: apply activeAccount, if set */
    const nextCommandStart = () => syncActiveAccountFromConfig(accountsDb)

    const failLogins = () => {
      deps.createClient = mock(() =>
        createMockClient({
          start: mock(() => Promise.reject(new Error('Code expired'))),
          signInQr: mock(() => Promise.reject(new Error('QR expired'))),
        }),
      )
    }

    beforeEach(() => {
      savedDataDir = process.env.TELEGRAM_SYNC_CLI_DATA_DIR
      dataDir = mkdtempSync(join(tmpdir(), 'telegram-sync-cli-auth-test-'))
      process.env.TELEGRAM_SYNC_CLI_DATA_DIR = dataDir
      deps.keepActiveAccountInConfig =
        getDefaultDependencies().keepActiveAccountInConfig
      deps.qrGenerator = { generate: mock(() => {}) }
      accountsDb.create({
        phone: '+15550000001',
        user_id: 999,
        is_active: true,
      })
    })

    afterEach(() => {
      process.env.TELEGRAM_SYNC_CLI_DATA_DIR = savedDataDir
      rmSync(dataDir, { recursive: true, force: true })
    })

    for (const [name, login] of logins) {
      it(`${name} makes a new account the only active one and creates no config.json`, async () => {
        const result = await login(deps)
        await nextCommandStart()

        expect(result.account?.id).toBe(2)
        expect(activeIds()).toEqual([2])
        expect(accountsDb.getActive()?.id).toBe(2)
        expect(existsSync(configPath())).toBe(false)
      })

      it(`${name} writes the account to activeAccount and keeps the other keys`, async () => {
        writeConfig(
          JSON.stringify({
            activeAccount: 1,
            cache: { staleness: { peers: '3d' } },
            note: 'kept',
          }),
        )

        const result = await login(deps)
        await nextCommandStart()

        expect(result.account?.id).toBe(2)
        expect(JSON.parse(readConfig())).toEqual({
          activeAccount: 2,
          cache: { staleness: { peers: '3d' } },
          note: 'kept',
        })
        expect(activeIds()).toEqual([2])
      })

      it(`${name} leaves a config.json without activeAccount byte for byte`, async () => {
        const text = '{"cache":{"staleness":{"peers":"3d"}}}'
        writeConfig(text)

        await login(deps)
        await nextCommandStart()

        expect(readConfig()).toBe(text)
        expect(activeIds()).toEqual([2])
      })

      it(`${name} leaves the active account and config.json alone when it fails`, async () => {
        const text = JSON.stringify({ activeAccount: 1 })
        writeConfig(text)
        failLogins()

        const result = await login(deps)

        expect(result.success).toBe(false)
        expect(activeIds()).toEqual([1])
        expect(readConfig()).toBe(text)
      })

      it.skipIf(isRoot)(
        `${name} fails with GENERAL_ERROR when activeAccount can't be written`,
        async () => {
          const text = JSON.stringify({ activeAccount: 1 })
          writeConfig(text)
          chmodSync(configPath(), 0o444)
          const errorSpy = spyOn(console, 'error').mockImplementation(() => {})

          let printed: string | undefined
          const failure = await login(deps)
            .then(
              () => undefined,
              (err: Error & { code?: string; details?: unknown }) => err,
            )
            .finally(() => {
              printed = String(errorSpy.mock.calls.at(-1)?.[0])
              errorSpy.mockRestore()
            })

          expect(failure?.code).toBe('GENERAL_ERROR')
          expect(failure?.message).toStartWith(
            'Logged in as account 2, but could not write activeAccount to',
          )
          expect(failure?.details).toEqual({
            path: configPath(),
            account_id: 2,
          })
          // Removing the key alone would leave account 1 active, so the
          // switch follows either step
          expect(JSON.parse(printed ?? '').error.suggestion).toBe(
            'Make config.json writable or remove activeAccount from it, then run tg accounts switch --id 2',
          )
          // config.json first: data.db keeps account 1 active as well
          expect(readConfig()).toBe(text)
          expect(activeIds()).toEqual([1])
        },
      )
    }

    it('a failed re-login leaves the active account alone', async () => {
      accountsDb.create({ phone: PHONE })
      failLogins()

      const result = await loginWithPhone(PHONE, deps)

      expect(result.success).toBe(false)
      expect(activeIds()).toEqual([1])
    })

    it('leaves config.json alone when activeAccount already names the account', async () => {
      accountsDb.create({ phone: PHONE })
      const text = JSON.stringify({ activeAccount: 2 })
      writeConfig(text)

      await loginWithPhone(PHONE, deps)
      await nextCommandStart()

      expect(readConfig()).toBe(text)
      expect(activeIds()).toEqual([2])
    })

    it('writes the account a QR login merges into, not the one it created', async () => {
      accountsDb.create({ phone: '+15550000003', user_id: 456 })
      writeConfig(JSON.stringify({ activeAccount: 1 }))

      const result = await loginWithQr('Again', deps)
      await nextCommandStart()

      expect(result.account?.id).toBe(2)
      expect(accountsDb.count()).toBe(2)
      expect(JSON.parse(readConfig())).toEqual({ activeAccount: 2 })
      expect(activeIds()).toEqual([2])
    })
  })

  describe('logout', () => {
    it('should logout and delete account', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })

      const result = await logout(account.id, deps)

      expect(result.success).toBe(true)
      expect(result.accountId).toBe(account.id)
      expect(result.phone).toBe('+1234567890')
      expect(accountsDb.getById(account.id)).toBeNull()
    })

    it('should logout active account if no ID specified', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })

      const result = await logout(undefined, deps)

      expect(result.success).toBe(true)
      expect(result.accountId).toBe(account.id)
    })

    it('should return error if no account found', async () => {
      const result = await logout(undefined, deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('No account found to logout')
    })

    it('should return error if specified account not found', async () => {
      const result = await logout(999, deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('No account found to logout')
    })

    it('should call auth.logOut on client', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      const client = deps.getClient(account.id)

      await logout(account.id, deps)

      expect(client.call).toHaveBeenCalledWith({ _: 'auth.logOut' })
    })

    it('should return error on API failure', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.getClient = mock(() =>
        createMockClient({
          call: mock(() => Promise.reject(new Error('Network error'))),
        }),
      )

      const result = await logout(account.id, deps)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })

  describe('getAuthStatus', () => {
    it('should return authenticated status', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.resolve(true))

      const result = await getAuthStatus(account.id, deps)

      expect(result.authenticated).toBe(true)
      expect(result.account).toBeDefined()
      expect(result.account?.phone).toBe('+1234567890')
      expect(result.account?.username).toBe('testuser')
      expect(result.account?.userId).toBe(123)
    })

    it('should return not authenticated if no account', async () => {
      const result = await getAuthStatus(undefined, deps)

      expect(result.authenticated).toBe(false)
      expect(result.message).toBe('No account configured')
    })

    it('should use active account if no ID specified', async () => {
      accountsDb.create({ phone: '+1234567890', is_active: true })

      const result = await getAuthStatus(undefined, deps)

      expect(result.account?.phone).toBe('+1234567890')
    })

    it('should return not authenticated if client not authorized', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.resolve(false))

      const result = await getAuthStatus(account.id, deps)

      expect(result.authenticated).toBe(false)
      expect(result.message).toContain('not authenticated')
    })

    it('should return not authenticated on error', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.reject(new Error('Network error')))

      const result = await getAuthStatus(account.id, deps)

      expect(result.authenticated).toBe(false)
      expect(result.message).toBe('Could not verify authentication status')
    })

    it('should return account info even when not authorized', async () => {
      const account = accountsDb.create({
        phone: '+1234567890',
        is_active: true,
      })
      deps.isAuthorized = mock(() => Promise.resolve(false))

      const result = await getAuthStatus(account.id, deps)

      expect(result.account).toBeDefined()
      expect(result.account?.id).toBe(account.id)
      expect(result.account?.phone).toBe('+1234567890')
    })
  })
})
