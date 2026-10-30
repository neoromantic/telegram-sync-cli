import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SYNC_PACING,
  type SyncPacingConfig,
} from '../daemon/sync-pacing'
import { type AccountsDbInterface, accountsDb } from '../db'
import type {
  CacheConfig,
  CacheRetentionConfig,
  DurationString,
} from '../db/types'
import {
  getDefaultCacheConfig,
  getDefaultRetentionConfig,
  parseDuration,
} from '../db/types'

/**
 * `positiveDuration` is a duration above 0, such as a retention; `rate` is
 * a number of calls per second above 0 and at most MAX_CALLS_PER_SECOND
 */
type ConfigValueType =
  | 'number'
  | 'boolean'
  | 'duration'
  | 'positiveDuration'
  | 'rate'

/** The fastest `sync.pacing.maxCallsPerSecond` accepts */
const MAX_CALLS_PER_SECOND = 2

const TYPE_DESCRIPTIONS: Record<ConfigValueType, string> = {
  number: 'number',
  boolean: 'boolean',
  duration: 'duration',
  positiveDuration: 'duration above 0',
  rate: `number above 0 and at most ${MAX_CALLS_PER_SECOND}`,
}

export type ConfigLeafKey =
  | 'activeAccount'
  | 'cache.staleness.peers'
  | 'cache.staleness.dialogs'
  | 'cache.staleness.fullInfo'
  | 'cache.backgroundRefresh'
  | 'cache.maxCacheAge'
  | 'cache.retention.apiActivity'
  | 'cache.retention.rateLimits'
  | 'cache.retention.completedJobs'
  | 'cache.retention.failedJobs'
  | 'sync.pacing.maxCallsPerSecond'
  | 'sync.pacing.calmInterval'

const CONFIG_LEAF_TYPES: Record<ConfigLeafKey, ConfigValueType> = {
  activeAccount: 'number',
  'cache.staleness.peers': 'duration',
  'cache.staleness.dialogs': 'duration',
  'cache.staleness.fullInfo': 'duration',
  'cache.backgroundRefresh': 'boolean',
  'cache.maxCacheAge': 'duration',
  'cache.retention.apiActivity': 'positiveDuration',
  'cache.retention.rateLimits': 'positiveDuration',
  'cache.retention.completedJobs': 'positiveDuration',
  'cache.retention.failedJobs': 'positiveDuration',
  'sync.pacing.maxCallsPerSecond': 'rate',
  'sync.pacing.calmInterval': 'positiveDuration',
}

const CONFIG_PREFIX_KEYS = new Set<string>([
  'cache',
  'cache.staleness',
  'cache.retention',
  'sync',
  'sync.pacing',
])

/** The retention keys and the CacheRetentionConfig field each one sets */
const RETENTION_KEYS = {
  apiActivity: 'cache.retention.apiActivity',
  rateLimits: 'cache.retention.rateLimits',
  completedJobs: 'cache.retention.completedJobs',
  failedJobs: 'cache.retention.failedJobs',
} as const satisfies Record<keyof CacheRetentionConfig, ConfigLeafKey>

export interface CacheStalenessConfigFile {
  peers?: DurationString
  dialogs?: DurationString
  fullInfo?: DurationString
}

export interface CacheRetentionConfigFile {
  apiActivity?: DurationString
  rateLimits?: DurationString
  completedJobs?: DurationString
  failedJobs?: DurationString
}

export interface CacheConfigFile {
  staleness?: CacheStalenessConfigFile
  retention?: CacheRetentionConfigFile
  backgroundRefresh?: boolean
  maxCacheAge?: DurationString
}

export interface SyncPacingConfigFile {
  maxCallsPerSecond?: number
  calmInterval?: DurationString
}

export interface SyncConfigFile {
  pacing?: SyncPacingConfigFile
}

export interface ConfigFile {
  activeAccount?: number
  cache?: CacheConfigFile
  sync?: SyncConfigFile
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

function isValidDuration(
  value: string,
  options: { positive?: boolean } = {},
): value is DurationString {
  const normalized = normalizeDuration(value)
  try {
    const ms = parseDuration(normalized as DurationString)
    return !options.positive || ms > 0
  } catch {
    return false
  }
}

function isValidRate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_CALLS_PER_SECOND
  )
}

function validateValue(type: ConfigValueType, value: unknown): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isInteger(value) && value > 0
    case 'boolean':
      return typeof value === 'boolean'
    case 'duration':
      return typeof value === 'string' && isValidDuration(value)
    case 'positiveDuration':
      return (
        typeof value === 'string' && isValidDuration(value, { positive: true })
      )
    case 'rate':
      return isValidRate(value)
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
        message: `Expected ${TYPE_DESCRIPTIONS[type as ConfigValueType]}`,
      })
      continue
    }

    const normalizedValue =
      (type === 'duration' || type === 'positiveDuration') &&
      typeof value === 'string'
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
    case 'positiveDuration': {
      const normalized = normalizeDuration(trimmed)
      if (!isValidDuration(normalized, { positive: true })) {
        throw new ConfigError('Invalid value', [
          {
            path: key,
            message: 'Expected a duration above 0, like 7d, 1h, 30m',
          },
        ])
      }
      return normalized
    }
    case 'rate': {
      const parsed = Number(trimmed)
      if (trimmed === '' || !isValidRate(parsed)) {
        throw new ConfigError('Invalid value', [
          {
            path: key,
            message: `Expected a ${TYPE_DESCRIPTIONS.rate}, like 0.9`,
          },
        ])
      }
      return parsed
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
      {
        path: key,
        message: `Expected ${TYPE_DESCRIPTIONS[CONFIG_LEAF_TYPES[key]]}`,
      },
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
    retention: resolveRetention(config),
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

/** The retention config.json sets, over the defaults */
function resolveRetention(config: ConfigFile): CacheRetentionConfig {
  const retention = getDefaultRetentionConfig()
  for (const field of Object.keys(RETENTION_KEYS) as Array<
    keyof CacheRetentionConfig
  >) {
    const value = config.cache?.retention?.[field]
    if (value) retention[field] = parseDuration(value)
  }
  return retention
}

/** The pacing config.json sets, over the defaults */
function resolvePacing(config: ConfigFile): SyncPacingConfig {
  const pacing = { ...DEFAULT_SYNC_PACING }
  const file = config.sync?.pacing
  if (file?.maxCallsPerSecond) pacing.maxCallsPerSecond = file.maxCallsPerSecond
  if (file?.calmInterval)
    pacing.calmIntervalMs = parseDuration(file.calmInterval)
  return pacing
}

/** The keys the daemon reads; the other commands read the rest */
const DAEMON_KEY_PREFIXES = ['cache.retention.', 'sync.pacing.']

/**
 * The retention and the sync pacing for the daemon, read once at its start.
 * Unlike the commands it never fails: bad JSON, an unreadable file or a bad
 * value gives one warning, and every key that can't be read keeps its
 * default.
 */
export async function loadDaemonConfig(
  options: { dataDir?: string } = {},
): Promise<{
  retention: CacheRetentionConfig
  pacing: SyncPacingConfig
  warning: string | null
}> {
  const fallback = 'using the defaults'
  let loaded: Awaited<ReturnType<typeof loadConfig>>
  try {
    loaded = await loadConfig({ dataDir: options.dataDir, strict: false })
  } catch (err) {
    const why =
      err instanceof ConfigError
        ? `${err.message}${err.issues[0] ? `: ${err.issues[0].message}` : ''}`
        : err instanceof Error
          ? err.message
          : String(err)
    return {
      retention: getDefaultRetentionConfig(),
      pacing: { ...DEFAULT_SYNC_PACING },
      warning: `${getConfigPath(options.dataDir)}: ${why}; ${fallback}`,
    }
  }

  const bad = loaded.errors.filter((issue) =>
    DAEMON_KEY_PREFIXES.some((prefix) => issue.path.startsWith(prefix)),
  )
  return {
    retention: resolveRetention(loaded.config),
    pacing: resolvePacing(loaded.config),
    warning:
      bad.length === 0
        ? null
        : `Invalid ${bad.map((issue) => `${issue.path} (${issue.message})`).join(', ')} in ${getConfigPath(options.dataDir)}; using the default for ${bad.length === 1 ? 'it' : 'them'}`,
  }
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
