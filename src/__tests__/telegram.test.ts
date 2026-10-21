/**
 * Telegram service tests
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import {
  HttpProxyTcpTransport,
  SocksProxyTcpTransport,
  type TelegramClient,
} from '@mtcute/bun'
import { ConfigError } from '../config'
import { type AccountsDbInterface, createTestDatabase } from '../db'
import {
  type ClientFactory,
  createClientManager,
  createDefaultClientFactory,
  getDefaultConfig,
  getSessionPath,
  isAuthorized,
  type TelegramClientManager,
  type TelegramConfig,
  validateConfig,
} from '../services/telegram'

// Set test environment
process.env.BUN_ENV = 'test'

describe('Telegram Service', () => {
  describe('getDefaultConfig', () => {
    afterEach(() => {
      delete process.env.TELEGRAM_PROXY
    })

    it('should return config from environment', () => {
      const config = getDefaultConfig()

      expect(config).toHaveProperty('apiId')
      expect(config).toHaveProperty('apiHash')
      expect(config).toHaveProperty('logLevel')
      expect(typeof config.apiId).toBe('number')
      expect(typeof config.apiHash).toBe('string')
      expect(typeof config.logLevel).toBe('number')
      expect(config).not.toHaveProperty('transport')
    })

    it('parses a SOCKS5 proxy with credentials', () => {
      process.env.TELEGRAM_PROXY = 'socks5://user:secret@127.0.0.1:1080'
      expect(getDefaultConfig().transport).toEqual(
        new SocksProxyTcpTransport({
          version: 5,
          host: '127.0.0.1',
          port: 1080,
          user: 'user',
          password: 'secret',
        }),
      )
    })

    it('parses an HTTP proxy with credentials', () => {
      process.env.TELEGRAM_PROXY = 'http://user:secret@127.0.0.1:8080'
      expect(getDefaultConfig().transport).toEqual(
        new HttpProxyTcpTransport({
          tls: false,
          host: '127.0.0.1',
          port: 8080,
          user: 'user',
          password: 'secret',
        }),
      )
    })

    it.each([
      '',
      '127.0.0.1:1080',
      'socks5h://user:secret@127.0.0.1:1080',
      'http://user:secret@127.0.0.1:invalid',
      'tg://proxy?server=localhost&port=443&secret=invalid',
    ])('rejects an invalid proxy without exposing it: %s', (url) => {
      process.env.TELEGRAM_PROXY = url
      expect(getDefaultConfig).toThrow(ConfigError)
      expect(getDefaultConfig).toThrow('Invalid TELEGRAM_PROXY URL')
    })
  })

  describe('validateConfig', () => {
    it('should return valid for correct config', () => {
      const config: TelegramConfig = {
        apiId: 12345,
        apiHash: 'abc123',
        logLevel: 2,
      }

      const result = validateConfig(config)

      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    })

    it('should return invalid for missing apiId', () => {
      const config: TelegramConfig = {
        apiId: 0,
        apiHash: 'abc123',
        logLevel: 2,
      }

      const result = validateConfig(config)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('TELEGRAM_API_ID')
    })

    it('should return invalid for negative apiId', () => {
      const config: TelegramConfig = {
        apiId: -1,
        apiHash: 'abc123',
        logLevel: 2,
      }

      const result = validateConfig(config)

      expect(result.valid).toBe(false)
    })

    it('should return invalid for missing apiHash', () => {
      const config: TelegramConfig = {
        apiId: 12345,
        apiHash: '',
        logLevel: 2,
      }

      const result = validateConfig(config)

      expect(result.valid).toBe(false)
      expect(result.error).toContain('TELEGRAM_API_HASH')
    })
  })

  describe('getSessionPath', () => {
    it('should return path with account ID', () => {
      const path = getSessionPath(1, '/tmp')

      expect(path).toBe('/tmp/session_1.db')
    })

    it('should handle different account IDs', () => {
      const path1 = getSessionPath(1, '/data')
      const path2 = getSessionPath(42, '/data')

      expect(path1).toBe('/data/session_1.db')
      expect(path2).toBe('/data/session_42.db')
    })
  })

  describe('createDefaultClientFactory', () => {
    it('should create a factory', () => {
      const config: TelegramConfig = {
        apiId: 12345,
        apiHash: 'abc123',
        logLevel: 2,
      }

      const factory = createDefaultClientFactory(config, '/tmp')

      expect(factory).toBeDefined()
      expect(typeof factory.create).toBe('function')
    })
  })

  describe('createClientManager', () => {
    let mockFactory: ClientFactory
    let accountsDb: AccountsDbInterface
    let manager: TelegramClientManager
    let createdClients: Map<number, object>

    beforeEach(() => {
      createdClients = new Map()

      // Create mock factory
      mockFactory = {
        create: mock((accountId: number) => {
          const client = {
            id: accountId,
            start: mock(() =>
              Promise.resolve({
                firstName: 'Test',
                lastName: 'User',
                username: 'testuser',
                id: 123,
              }),
            ),
            getMe: mock(() =>
              Promise.resolve({
                firstName: 'Test',
                username: 'testuser',
                id: 123,
              }),
            ),
            signInQr: mock(() =>
              Promise.resolve({ firstName: 'Test', id: 123 }),
            ),
            call: mock(() => Promise.resolve({})),
          }
          createdClients.set(accountId, client)
          return client as unknown as TelegramClient
        }),
      }

      const testDb = createTestDatabase()
      accountsDb = testDb.accountsDb

      manager = createClientManager(mockFactory, accountsDb)
    })

    describe('createClient', () => {
      it('should create a new client', () => {
        const client = manager.createClient(1)

        expect(client).toBeDefined()
        expect(mockFactory.create).toHaveBeenCalledTimes(1)
      })

      it('should store client in cache', () => {
        manager.createClient(1)

        expect(manager.hasClient(1)).toBe(true)
      })
    })

    describe('getClient', () => {
      it('should return cached client', () => {
        const client1 = manager.createClient(1)
        const client2 = manager.getClient(1)

        expect(client1).toBe(client2)
        expect(mockFactory.create).toHaveBeenCalledTimes(1)
      })

      it('should create new client if not cached', () => {
        const client = manager.getClient(1)

        expect(client).toBeDefined()
        expect(mockFactory.create).toHaveBeenCalledTimes(1)
      })
    })

    describe('getActiveClient', () => {
      it('should throw if no active account', () => {
        expect(() => manager.getActiveClient()).toThrow('No active account')
      })

      it('should return client for active account', () => {
        const account = accountsDb.create({
          phone: '+1234567890',
          is_active: true,
        })
        const client = manager.getActiveClient()

        expect(client).toBeDefined()
        expect(createdClients.has(account.id)).toBe(true)
      })
    })

    describe('getClientForAccount', () => {
      it('should return client for specific account ID', () => {
        const account = accountsDb.create({ phone: '+1234567890' })
        const client = manager.getClientForAccount(account.id)

        expect(client).toBeDefined()
      })

      it('should throw if account ID not found', () => {
        expect(() => manager.getClientForAccount(999)).toThrow(
          'Account with ID 999 not found',
        )
      })

      it('should return active client if no ID specified', () => {
        accountsDb.create({ phone: '+1234567890', is_active: true })
        const client = manager.getClientForAccount()

        expect(client).toBeDefined()
      })

      it('should throw if no ID and no active account', () => {
        expect(() => manager.getClientForAccount()).toThrow('No active account')
      })
    })

    describe('removeClient', () => {
      it('should remove client from cache', () => {
        manager.createClient(1)
        expect(manager.hasClient(1)).toBe(true)

        manager.removeClient(1)
        expect(manager.hasClient(1)).toBe(false)
      })

      it('should not throw for non-existent client', () => {
        expect(() => manager.removeClient(999)).not.toThrow()
      })
    })

    describe('removeAllClients', () => {
      it('should remove all clients from cache', () => {
        manager.createClient(1)
        manager.createClient(2)
        manager.createClient(3)

        manager.removeAllClients()

        expect(manager.hasClient(1)).toBe(false)
        expect(manager.hasClient(2)).toBe(false)
        expect(manager.hasClient(3)).toBe(false)
      })
    })

    describe('hasClient', () => {
      it('should return true for cached client', () => {
        manager.createClient(1)
        expect(manager.hasClient(1)).toBe(true)
      })

      it('should return false for non-cached client', () => {
        expect(manager.hasClient(999)).toBe(false)
      })
    })
  })

  describe('isAuthorized', () => {
    it('should return true when getMe succeeds', async () => {
      const mockClient = {
        getMe: mock(() => Promise.resolve({ id: 123, firstName: 'Test' })),
      } as unknown as TelegramClient

      const result = await isAuthorized(mockClient)

      expect(result).toBe(true)
    })

    it('should return false when getMe throws', async () => {
      const mockClient = {
        getMe: mock(() => Promise.reject(new Error('Not authorized'))),
      } as unknown as TelegramClient

      const result = await isAuthorized(mockClient)

      expect(result).toBe(false)
    })
  })
})
