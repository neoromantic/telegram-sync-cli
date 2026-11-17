/**
 * Type definitions for the caching system
 *
 * Based on docs/caching.md and docs/database-schema.md
 */

// =============================================================================
// Cache Configuration
// =============================================================================

/**
 * Cache staleness configuration in milliseconds
 */
export interface CacheStalenessConfig {
  /** TTL for peers (users, groups, channels) - default 7 days */
  peers: number
  /** TTL for dialog list ordering - default 1 hour */
  dialogs: number
  /** TTL for extended peer info (about, bio) - default 7 days */
  fullInfo: number
}

/**
 * How long the cache keeps its bookkeeping rows, in milliseconds. Messages,
 * chats and users are never pruned.
 */
export interface CacheRetentionConfig {
  /** api_activity rows - default 7 days */
  apiActivity: number
  /** rate_limits windows; a running FLOOD_WAIT is always kept - default 1 hour */
  rateLimits: number
  /** Completed sync jobs - default 24 hours */
  completedJobs: number
  /**
   * Failed sync jobs - default 24 hours. A failed row keeps its job from
   * being queued again, so this is also the retry delay after the backoff
   * gives up.
   */
  failedJobs: number
}

/**
 * Complete cache configuration
 */
export interface CacheConfig {
  /** Staleness thresholds for different data types */
  staleness: CacheStalenessConfig
  /** Enable background refresh for stale data */
  backgroundRefresh: boolean
  /** Hard limit before cache eviction in milliseconds */
  maxCacheAge: number
  /** How long the bookkeeping tables keep their rows */
  retention: CacheRetentionConfig
}

// Duration constants in milliseconds
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** Default retention of the bookkeeping tables */
export function getDefaultRetentionConfig(): CacheRetentionConfig {
  return {
    apiActivity: WEEK,
    rateLimits: HOUR,
    completedJobs: DAY,
    failedJobs: DAY,
  }
}

/**
 * Returns default cache configuration
 */
export function getDefaultCacheConfig(): CacheConfig {
  return {
    staleness: {
      peers: WEEK, // 7 days
      dialogs: HOUR, // 1 hour
      fullInfo: WEEK, // 7 days
    },
    backgroundRefresh: true,
    maxCacheAge: 30 * DAY, // 30 days
    retention: getDefaultRetentionConfig(),
  }
}

/** Chat type enumeration */
export type ChatType =
  | 'private'
  | 'group'
  | 'supergroup'
  | 'channel'
  | 'community'

/**
 * API activity log entry
 * Maps to api_activity table
 */
export interface ApiActivityEntry {
  /** Auto-incremented ID */
  id: number
  /** Unix timestamp of the call */
  timestamp: number
  /** API method name */
  method: string
  /** Related chat ID if applicable (nullable) */
  chat_id: number | null
  /** 1 if successful, 0 if failed */
  success: number
  /** Error code if failed (nullable) */
  error_code: number | null
  /** Error message if failed (nullable) */
  error_message: string | null
  /** Response time in milliseconds */
  response_ms: number | null
  /** Request payload size in bytes */
  request_size: number | null
  /** Response payload size in bytes */
  response_size: number | null
}

/**
 * Duration units for human-readable staleness config
 */
export type DurationUnit = 's' | 'm' | 'h' | 'd' | 'w'

/**
 * Human-readable duration string (e.g., "7d", "1h")
 */
export type DurationString = `${number}${DurationUnit}`

/**
 * Cache staleness config with human-readable durations
 */
export interface CacheStalenessConfigReadable {
  peers: DurationString
  dialogs: DurationString
  fullInfo: DurationString
}

/**
 * Parse a human-readable duration string to milliseconds
 */
export function parseDuration(duration: DurationString): number {
  const match = duration.match(/^(\d+)(s|m|h|d|w)$/)
  const value = match?.[1]
  const unit = match?.[2] as DurationUnit | undefined

  if (!value || !unit) {
    throw new Error(`Invalid duration: ${duration}`)
  }
  const multipliers: Record<DurationUnit, number> = {
    s: SECOND,
    m: MINUTE,
    h: HOUR,
    d: DAY,
    w: WEEK,
  }

  return Number.parseInt(value, 10) * multipliers[unit]
}

/**
 * Check if a cached entry is stale
 */
export function isCacheStale(fetchedAt: number | null, ttlMs: number): boolean {
  if (fetchedAt === null) return true
  return Date.now() - fetchedAt > ttlMs
}
