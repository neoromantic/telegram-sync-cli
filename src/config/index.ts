import { homedir } from 'node:os'
import { join } from 'node:path'
import { type AccountsDbInterface, accountsDb } from '../db'
import type { CacheConfig, DurationString } from '../db/types'
import { getDefaultCacheConfig, parseDuration } from '../db/types'

type ConfigValueType = 'number' | 'boolean' | 'duration'

export type ConfigLeafKey =
  | 'activeAccount'
  | 'cache.staleness.peers'
  | 'cache.staleness.dialogs'
  | 'cache.staleness.fullInfo'
  | 'cache.backgroundRefresh'
  | 'cache.maxCacheAge'

const CONFIG_LEAF_TYPES: Record<ConfigLeafKey, ConfigValueType> = {
  activeAccount: 'number',
  'cache.staleness.peers': 'duration',
  'cache.staleness.dialogs': 'duration',
  'cache.staleness.fullInfo': 'duration',
  'cache.backgroundRefresh': 'boolean',
  'cache.maxCacheAge': 'duration',
}

const CONFIG_PREFIX_KEYS = new Set<string>(['cache', 'cache.staleness'])

export interface CacheStalenessConfigFile {
  peers?: DurationString
  dialogs?: DurationString
  fullInfo?: DurationString
}

export interface CacheConfigFile {
  staleness?: CacheStalenessConfigFile
  backgroundRefresh?: boolean
  maxCacheAge?: DurationString
}

export interface ConfigFile {
  activeAccount?: number
  cache?: CacheConfigFile
}

export interface ConfigIssue {
  path: string
  message: string
}

export class ConfigError extends Error {
  issues: ConfigIssue[]

  constructor(message: string, issues: ConfigIssue[]) {
    super(message)
    this.name = 'ConfigError'
    this.issues = issues
  }
}

/** config.json exists but can't be read, for example for lack of permission */
export class ConfigReadError extends Error {
  path: string

  constructor(path: string, cause: Error) {
    const reason = (cause as NodeJS.ErrnoException).code ?? cause.message
    super(`Could not read ${path}: ${reason}`)
    this.name = 'ConfigReadError'
    this.path = path
  }
}

function resolveDataDir(dataDir?: string): string {
  return (
    dataDir ??
    process.env.TELEGRAM_SYNC_CLI_DATA_DIR ??
    join(homedir(), '.telegram-sync-cli')
  )
}

export function getConfigPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), 'config.json')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getPathValue(data: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = data
  for (const key of path) {
    if (!isPlainObject(current)) return undefined
    current = current[key]
  }
  return current
}

function setPathValue(
  data: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let current: Record<string, unknown> = data
  for (const [index, key] of path.entries()) {
    if (index === path.length - 1) {
      current[key] = value
      return
    }
    const existing = current[key]
    if (!isPlainObject(existing)) {
      current[key] = {}
    }
    current = current[key] as Record<string, unknown>
  }
}

function normalizeDuration(value: DurationString): DurationString
function normalizeDuration(value: string): string
function normalizeDuration(value: string): string {
  return value.trim().toLowerCase()
}

function isValidDuration(value: string): value is DurationString {
  const normalized = normalizeDuration(value)
  try {
    parseDuration(normalized as DurationString)
    return true
  } catch {
    return false
  }
}

function validateValue(type: ConfigValueType, value: unknown): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isInteger(value) && value > 0
    case 'boolean':
      return typeof value === 'boolean'
    case 'duration':
      return typeof value === 'string' && isValidDuration(value)
    default:
      return false
  }
}

function sanitizeConfig(raw: Record<string, unknown>): {
  config: ConfigFile
  errors: ConfigIssue[]
} {
  const config: ConfigFile = {}
  const errors: ConfigIssue[] = []

  for (const [path, type] of Object.entries(CONFIG_LEAF_TYPES)) {
    const value = getPathValue(raw, path.split('.'))
    if (value === undefined) continue

    if (!validateValue(type as ConfigValueType, value)) {
      errors.push({
        path,
        message: `Expected ${type}`,
      })
      continue
    }

    const normalizedValue =
      type === 'duration' && typeof value === 'string'
        ? normalizeDuration(value)
        : value
    setPathValue(
      config as Record<string, unknown>,
      path.split('.'),
      normalizedValue,
    )
  }

  return { config, errors }
}

async function readConfigJson(dataDir?: string): Promise<{
  raw: Record<string, unknown>
  exists: boolean
}> {
  const path = getConfigPath(dataDir)
  const file = Bun.file(path)
  if (!(await file.exists())) {
    return { raw: {}, exists: false }
  }

  let text: string
  try {
    text = await file.text()
  } catch (err) {
    throw new ConfigReadError(path, err as Error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (err) {
    throw new ConfigError('Invalid JSON in config file', [
      { path: '(root)', message: (err as Error).message },
    ])
  }

  if (!isPlainObject(parsed)) {
    throw new ConfigError('Config file must contain a JSON object', [
      { path: '(root)', message: 'Expected an object' },
    ])
  }

  return { raw: parsed, exists: true }
}

export async function loadConfig(
  options: { strict?: boolean; dataDir?: string } = {},
): Promise<{
  config: ConfigFile
  exists: boolean
  errors: ConfigIssue[]
}> {
  const { strict = false, dataDir } = options

  const { raw, exists } = await readConfigJson(dataDir)
  const { config, errors } = sanitizeConfig(raw)

  if (strict && errors.length > 0) {
    throw new ConfigError('Config file has invalid values', errors)
  }

  return { config, exists, errors }
}

export function isConfigKey(key: string): boolean {
  return key in CONFIG_LEAF_TYPES || CONFIG_PREFIX_KEYS.has(key)
}

export function isConfigLeafKey(key: string): key is ConfigLeafKey {
  return key in CONFIG_LEAF_TYPES
}

export function parseConfigValue(
  key: ConfigLeafKey,
  rawValue: string,
): unknown {
  const type = CONFIG_LEAF_TYPES[key]
  const trimmed = rawValue.trim()

  switch (type) {
    case 'number': {
      const parsed = Number.parseInt(trimmed, 10)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new ConfigError('Invalid value', [
          { path: key, message: 'Expected a positive integer' },
        ])
      }
      return parsed
    }
    case 'boolean': {
      const normalized = trimmed.toLowerCase()
      if (normalized !== 'true' && normalized !== 'false') {
        throw new ConfigError('Invalid value', [
          { path: key, message: 'Expected true or false' },
        ])
      }
      return normalized === 'true'
    }
    case 'duration': {
      const normalized = normalizeDuration(trimmed)
      if (!isValidDuration(normalized)) {
        throw new ConfigError('Invalid value', [
          { path: key, message: 'Expected duration like 7d, 1h, 30m' },
        ])
      }
      return normalized
    }
  }
}

export async function getConfigValue(
  key: string,
  options: { dataDir?: string; strict?: boolean } = {},
): Promise<unknown> {
  const { config } = await loadConfig({
    dataDir: options.dataDir,
    strict: options.strict ?? false,
  })
  return getPathValue(config as Record<string, unknown>, key.split('.'))
}

export async function setConfigValue(
  key: ConfigLeafKey,
  value: unknown,
  options: { dataDir?: string } = {},
): Promise<void> {
  if (!validateValue(CONFIG_LEAF_TYPES[key], value)) {
    throw new ConfigError('Invalid value', [
      { path: key, message: `Expected ${CONFIG_LEAF_TYPES[key]}` },
    ])
  }

  const { raw } = await readConfigJson(options.dataDir)
  setPathValue(raw, key.split('.'), value)
  await Bun.write(
    getConfigPath(options.dataDir),
    `${JSON.stringify(raw, null, 2)}\n`,
  )
}

export async function getResolvedCacheConfig(
  options: { dataDir?: string } = {},
): Promise<CacheConfig> {
  const { config } = await loadConfig({
    dataDir: options.dataDir,
    strict: true,
  })
  const defaults = getDefaultCacheConfig()
  const resolved: CacheConfig = {
    ...defaults,
    staleness: { ...defaults.staleness },
  }

  if (config.cache?.staleness?.peers) {
    resolved.staleness.peers = parseDuration(config.cache.staleness.peers)
  }
  if (config.cache?.staleness?.dialogs) {
    resolved.staleness.dialogs = parseDuration(config.cache.staleness.dialogs)
  }
  if (config.cache?.staleness?.fullInfo) {
    resolved.staleness.fullInfo = parseDuration(config.cache.staleness.fullInfo)
  }
  if (config.cache?.backgroundRefresh !== undefined) {
    resolved.backgroundRefresh = config.cache.backgroundRefresh
  }
  if (config.cache?.maxCacheAge) {
    resolved.maxCacheAge = parseDuration(config.cache.maxCacheAge)
  }

  return resolved
}

export async function syncActiveAccountFromConfig(
  accounts: AccountsDbInterface = accountsDb,
  options: { dataDir?: string } = {},
): Promise<void> {
  const { config } = await loadConfig({
    dataDir: options.dataDir,
    strict: true,
  })
  if (!config.activeAccount) return
  const account = accounts.getById(config.activeAccount)
  if (!account) return
  accounts.setActive(account.id)
}
