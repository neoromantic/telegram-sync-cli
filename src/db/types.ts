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

// =============================================================================
// Base Cached Entity
// =============================================================================

/**
 * Base interface for all cached entities
 * All cached data includes timestamps for staleness tracking
 */
export interface CachedEntity {
  /** Unix timestamp (ms) when data was fetched from API */
  fetched_at: number
  /** Unix timestamp (ms) when record was first created */
  created_at: number
  /** Unix timestamp (ms) when record was last updated */
  updated_at: number
  /** Original TL object as JSON for future-proofing */
  raw_json: string
}

// =============================================================================
// Cached User
// =============================================================================

/**
 * Cached user/contact information
 * Maps to contacts_cache table
 */
export interface CachedUser extends CachedEntity {
  /** Telegram user ID */
  user_id: number
  /** @username without @ (nullable) */
  username: string | null
  /** User's first name */
  first_name: string
  /** User's last name (nullable) */
  last_name: string | null
  /** Phone number (nullable, contacts only) */
  phone: string | null
  /** Access hash required for API calls */
  access_hash: string | null
  /** 1 if in user's contacts */
  is_contact: number
  /** 1 if user is a bot */
  is_bot: number
  /** 1 if user has Telegram Premium */
  is_premium: number
}

/**
 * SQLite row class for CachedUser
 * Used with bun:sqlite .as() method
 */
export class CachedUserRow {
  user_id!: number
  username!: string | null
  first_name!: string
  last_name!: string | null
  phone!: string | null
  access_hash!: string | null
  is_contact!: number
  is_bot!: number
  is_premium!: number
  fetched_at!: number
  created_at!: number
  updated_at!: number
  raw_json!: string
}

// =============================================================================
// Cached Chat
// =============================================================================

/** Chat type enumeration */
export type ChatType =
  | 'private'
  | 'group'
  | 'supergroup'
  | 'channel'
  | 'community'

/**
 * Cached chat/dialog information
 * Maps to chats_cache table
 */
export interface CachedChat extends CachedEntity {
  /** Telegram chat/channel ID */
  chat_id: number
  /** Chat type */
  type: ChatType
  /** Chat title (groups/channels) or user name (private) */
  title: string | null
  /** @username for public chats (nullable) */
  username: string | null
  /** Number of members (nullable, groups/channels) */
  member_count: number | null
  /** 1 if user created this chat */
  is_creator: number
  /** 1 if user is admin */
  is_admin: number
  /** 1 if verified account */
  is_verified: number
  /** 1 if restricted */
  is_restricted: number
  /** Unread message count */
  unread_count: number
  /** ID of last message in chat */
  last_message_id: number | null
  /** Timestamp of last message */
  last_message_at: number | null
  /** 1 if auto-sync enabled for this chat */
  sync_enabled: number
  /** Higher = sync more frequently */
  sync_priority: number
  /** Order in pinned chats (nullable if not pinned) */
  pinned_order: number | null
}

/**
 * SQLite row class for CachedChat
 */
export class CachedChatRow {
  chat_id!: number
  type!: ChatType
  title!: string | null
  username!: string | null
  member_count!: number | null
  is_creator!: number
  is_admin!: number
  is_verified!: number
  is_restricted!: number
  unread_count!: number
  last_message_id!: number | null
  last_message_at!: number | null
  sync_enabled!: number
  sync_priority!: number
  pinned_order!: number | null
  fetched_at!: number
  created_at!: number
  updated_at!: number
  raw_json!: string
}

// =============================================================================
// Cached Message
// =============================================================================

/** Message type enumeration */
export type MessageType =
  | 'text'
  | 'photo'
  | 'video'
  | 'document'
  | 'sticker'
  | 'voice'
  | 'audio'
  | 'video_note'
  | 'animation'
  | 'poll'
  | 'contact'
  | 'location'
  | 'venue'
  | 'game'
  | 'invoice'
  | 'webpage'
  | 'dice'
  | 'service'
  | 'unknown'

/**
 * Cached message information
 * Maps to messages_cache table
 */
export interface CachedMessage extends CachedEntity {
  /** Chat this message belongs to */
  chat_id: number
  /** Message ID within the chat */
  message_id: number
  /** Sender user ID (nullable for channels) */
  from_id: number | null
  /** Message text content (nullable for media-only) */
  text: string | null
  /** Message type */
  message_type: MessageType
  /** Unix timestamp when message was sent */
  date: number
  /** 1 if sent by current user */
  is_outgoing: number
  /** 1 if message was edited */
  is_edited: number
  /** 1 if message is pinned */
  is_pinned: number
  /** 1 if message contains media */
  has_media: number
  /** ID of message being replied to (nullable) */
  reply_to_id: number | null
  /** Original sender if forwarded (nullable) */
  forward_from_id: number | null
  /** Local path to downloaded media (nullable) */
  media_path: string | null
  /** Unix timestamp of last edit (nullable) */
  edit_date: number | null
}

/**
 * SQLite row class for CachedMessage
 */
export class CachedMessageRow {
  chat_id!: number
  message_id!: number
  from_id!: number | null
  text!: string | null
  message_type!: MessageType
  date!: number
  is_outgoing!: number
  is_edited!: number
  is_pinned!: number
  has_media!: number
  reply_to_id!: number | null
  forward_from_id!: number | null
  media_path!: string | null
  edit_date!: number | null
  fetched_at!: number
  created_at!: number
  updated_at!: number
  raw_json!: string
}

// =============================================================================
// Sync State
// =============================================================================

/** Entity type for sync state tracking */
export type SyncEntityType = 'contacts' | 'dialogs' | `messages:${number}`

/**
 * Sync state for incremental fetching
 * Maps to sync_state table
 */
export interface SyncState {
  /** Entity type being synced */
  entity_type: string
  /** Cursor/offset for fetching newer data */
  forward_cursor: string | null
  /** Cursor/offset for fetching older data */
  backward_cursor: string | null
  /** 1 if historical sync reached the beginning */
  is_complete: number
  /** Unix timestamp of last successful sync */
  last_sync_at: number | null
  /** Unix timestamp when record was created */
  created_at: number
  /** Unix timestamp when record was last updated */
  updated_at: number
}

/**
 * SQLite row class for SyncState
 */
export class SyncStateRow {
  entity_type!: string
  forward_cursor!: string | null
  backward_cursor!: string | null
  is_complete!: number
  last_sync_at!: number | null
  created_at!: number
  updated_at!: number
}

// =============================================================================
// Rate Limiting
// =============================================================================

/**
 * Rate limit tracking entry
 * Maps to rate_limits table
 */
export interface RateLimitEntry {
  /** API method name (e.g., 'messages.getHistory') */
  method: string
  /** Start of rate limit window (Unix timestamp) */
  window_start: number
  /** Number of calls in current window */
  call_count: number
  /** Unix timestamp of last successful call */
  last_call_at: number
  /** Unix timestamp when flood wait expires (nullable) */
  flood_wait_until: number | null
  /** Average response time in milliseconds */
  avg_response_ms: number | null
  /** Unix timestamp when record was created */
  created_at: number
  /** Unix timestamp when record was last updated */
  updated_at: number
}

/**
 * SQLite row class for RateLimitEntry
 */
export class RateLimitEntryRow {
  method!: string
  window_start!: number
  call_count!: number
  last_call_at!: number
  flood_wait_until!: number | null
  avg_response_ms!: number | null
  created_at!: number
  updated_at!: number
}

// =============================================================================
// API Activity
// =============================================================================

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
 * SQLite row class for ApiActivityEntry
 */
export class ApiActivityEntryRow {
  id!: number
  timestamp!: number
  method!: string
  chat_id!: number | null
  success!: number
  error_code!: number | null
  error_message!: string | null
  response_ms!: number | null
  request_size!: number | null
  response_size!: number | null
}

// =============================================================================
// Cache Lookup Results
// =============================================================================

/** Source of data in cache lookup */
export type CacheSource = 'cache' | 'api'

/**
 * Result of a cache lookup operation
 * Used for stale-while-revalidate pattern
 */
export interface CacheLookupResult<T> {
  /** The data if found, null otherwise */
  data: T | null
  /** Where the data came from */
  source: CacheSource
  /** Whether the cached data is considered stale */
  stale: boolean
  /** Whether a background refresh was triggered */
  refreshTriggered: boolean
}

/**
 * Options for cache lookup operations
 */
export interface CacheLookupOptions {
  /** Bypass cache and fetch fresh data from API */
  fresh?: boolean
  /** Include stale data in response */
  allowStale?: boolean
}

// =============================================================================
// Background Refresh Jobs
// =============================================================================

/** Peer type for refresh jobs */
export type RefreshPeerType = 'user' | 'group' | 'channel'

/** Status of a refresh job */
export type RefreshJobStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'

/**
 * Background refresh job
 * Maps to refresh_jobs table
 */
export interface RefreshJob {
  /** Auto-incremented ID */
  id: number
  /** Peer ID to refresh */
  peer_id: string
  /** Type of peer */
  peer_type: RefreshPeerType
  /** Job status */
  status: RefreshJobStatus
  /** Higher = more urgent */
  priority: number
  /** Number of refresh attempts */
  attempts: number
  /** Last error message if failed */
  last_error: string | null
  /** When job was scheduled */
  scheduled_at: number
  /** When job started processing */
  started_at: number | null
  /** When job completed or failed */
  completed_at: number | null
}

/**
 * SQLite row class for RefreshJob
 */
export class RefreshJobRow {
  id!: number
  peer_id!: string
  peer_type!: RefreshPeerType
  status!: RefreshJobStatus
  priority!: number
  attempts!: number
  last_error!: string | null
  scheduled_at!: number
  started_at!: number | null
  completed_at!: number | null
}

// =============================================================================
// Cache Statistics
// =============================================================================

/**
 * Statistics for a single cache table
 */
export interface CacheTableStats {
  /** Total number of entries */
  total: number
  /** Number of stale entries */
  stale: number
  /** Oldest entry timestamp */
  oldest: number | null
  /** Newest entry timestamp */
  newest: number | null
}

/**
 * Overall cache statistics
 */
export interface CacheStats {
  /** User cache statistics */
  users: CacheTableStats
  /** Chat cache statistics */
  chats: CacheTableStats
  /** Message cache statistics */
  messages: CacheTableStats
  /** Number of pending refresh jobs */
  pendingJobs: number
  /** Number of failed refresh jobs */
  failedJobs: number
}

// =============================================================================
// Utility Types
// =============================================================================

/**
 * Input for creating/updating a cached user
 */
export type CachedUserInput = Omit<CachedUser, 'created_at' | 'updated_at'>

/**
 * Input for creating/updating a cached chat
 */
export type CachedChatInput = Omit<CachedChat, 'created_at' | 'updated_at'>

/**
 * Input for creating/updating a cached message
 */
export type CachedMessageInput = Omit<
  CachedMessage,
  'created_at' | 'updated_at'
>

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
