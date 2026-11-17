/**
 * Telegram service tests
 */

import { afterEach, describe, expect, it, mock } from 'bun:test'
import {
  HttpProxyTcpTransport,
  SocksProxyTcpTransport,
  type TelegramClient,
} from '@mtcute/bun'
import { ConfigError } from '../config'
import {
  createDefaultClientFactory,
  getDefaultConfig,
  getSessionPath,
  isAuthorized,
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
