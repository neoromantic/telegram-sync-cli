/**
 * Configuration system tests
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ConfigError,
  getConfigPath,
  getConfigValue,
  getResolvedCacheConfig,
  loadConfig,
  loadRetentionConfig,
  parseConfigValue,
  setConfigValue,
  syncActiveAccountFromConfig,
} from '../config'
import { createTestDatabase } from '../db'
import {
  getDefaultCacheConfig,
  getDefaultRetentionConfig,
  parseDuration,
} from '../db/types'

let dataDir: string

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'telegram-sync-cli-config-test-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('config', () => {
  it('returns empty config when file is missing', async () => {
    const result = await loadConfig({ dataDir })

    expect(result.exists).toBe(false)
    expect(result.config).toEqual({})
    expect(result.errors).toEqual([])
  })

  it('sets and gets config values', async () => {
    await setConfigValue('cache.staleness.peers', '2d', { dataDir })
    await setConfigValue('cache.backgroundRefresh', false, { dataDir })

    const peers = await getConfigValue('cache.staleness.peers', {
      dataDir,
      strict: true,
    })
    const backgroundRefresh = await getConfigValue('cache.backgroundRefresh', {
      dataDir,
      strict: true,
    })

    expect(peers).toBe('2d')
    expect(backgroundRefresh).toBe(false)
  })

  it('parses config values with validation', () => {
    expect(parseConfigValue('activeAccount', '2')).toBe(2)
    expect(parseConfigValue('cache.backgroundRefresh', 'true')).toBe(true)
    expect(parseConfigValue('cache.staleness.peers', ' 7D ')).toBe('7d')

    expect(() => parseConfigValue('activeAccount', '0')).toThrow(ConfigError)
    expect(() => parseConfigValue('cache.staleness.peers', 'nope')).toThrow(
      ConfigError,
    )
  })

  it('loads resolved cache config overrides', async () => {
    await setConfigValue('cache.staleness.peers', '3d', { dataDir })
    await setConfigValue('cache.maxCacheAge', '14d', { dataDir })

    const resolved = await getResolvedCacheConfig({ dataDir })
    const defaults = getDefaultCacheConfig()

    expect(resolved.staleness.peers).toBe(parseDuration('3d'))
    expect(resolved.maxCacheAge).toBe(parseDuration('14d'))
    expect(resolved.staleness.dialogs).toBe(defaults.staleness.dialogs)
    expect(resolved.backgroundRefresh).toBe(defaults.backgroundRefresh)
  })

  it('throws on invalid values in strict mode', async () => {
    const path = getConfigPath(dataDir)
    await Bun.write(
      path,
      JSON.stringify(
        {
          cache: {
            staleness: {
              peers: 'oops',
            },
          },
        },
        null,
        2,
      ),
    )

    await expect(loadConfig({ dataDir, strict: true })).rejects.toThrow(
      'Config file has invalid values',
    )
  })

  it('syncs active account from config', async () => {
    const { db, accountsDb } = createTestDatabase()
    const account1 = accountsDb.create({ phone: '+1111111111' })
    const account2 = accountsDb.create({ phone: '+2222222222' })

    expect(accountsDb.getActive()).toBeNull()

    await setConfigValue('activeAccount', account2.id, { dataDir })
    await syncActiveAccountFromConfig(accountsDb, { dataDir })

    const active = accountsDb.getActive()
    expect(active?.id).toBe(account2.id)
    expect(active?.id).not.toBe(account1.id)

    db.close()
  })

  describe('cache.retention', () => {
    const keys = [
      'cache.retention.apiActivity',
      'cache.retention.rateLimits',
      'cache.retention.completedJobs',
      'cache.retention.failedJobs',
    ] as const

    it('accepts a duration and rejects 0 and garbage', () => {
      for (const key of keys) {
        expect(parseConfigValue(key, '3d')).toBe('3d')
        expect(() => parseConfigValue(key, '0s')).toThrow(ConfigError)
        expect(() => parseConfigValue(key, 'abc')).toThrow(ConfigError)
      }
    })

    it('defaults to 7d, 1h, 24h and 24h', async () => {
      const { retention } = await getResolvedCacheConfig({ dataDir })

      expect(retention).toEqual({
        apiActivity: 7 * 24 * 60 * 60 * 1000,
        rateLimits: 60 * 60 * 1000,
        completedJobs: 24 * 60 * 60 * 1000,
        failedJobs: 24 * 60 * 60 * 1000,
      })
    })

    it('resolves a value config.json sets', async () => {
      await setConfigValue('cache.retention.failedJobs', '2h', { dataDir })

      const { retention } = await getResolvedCacheConfig({ dataDir })

      expect(retention.failedJobs).toBe(parseDuration('2h'))
      expect(retention.apiActivity).toBe(
        getDefaultRetentionConfig().apiActivity,
      )
    })

    it('rejects 0s in config.json in strict mode', async () => {
      await Bun.write(
        getConfigPath(dataDir),
        JSON.stringify({ cache: { retention: { rateLimits: '0s' } } }),
      )

      await expect(getResolvedCacheConfig({ dataDir })).rejects.toThrow(
        ConfigError,
      )
    })
  })

  describe('loadRetentionConfig', () => {
    it('falls back to the defaults on invalid JSON', async () => {
      await Bun.write(getConfigPath(dataDir), '{ not json')

      const result = await loadRetentionConfig({ dataDir })

      expect(result.retention).toEqual(getDefaultRetentionConfig())
      expect(result.warning).toContain('Invalid JSON')
    })

    it('falls back to the default for a bad value', async () => {
      await Bun.write(
        getConfigPath(dataDir),
        JSON.stringify({ cache: { retention: { apiActivity: 'x' } } }),
      )

      const result = await loadRetentionConfig({ dataDir })

      expect(result.retention).toEqual(getDefaultRetentionConfig())
      expect(result.warning).toContain('cache.retention.apiActivity')
    })

    it('reads valid values without a warning', async () => {
      await setConfigValue('cache.retention.apiActivity', '3d', { dataDir })

      const result = await loadRetentionConfig({ dataDir })

      expect(result.retention.apiActivity).toBe(parseDuration('3d'))
      expect(result.warning).toBeNull()
    })
  })
})
