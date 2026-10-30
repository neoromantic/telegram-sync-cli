/**
 * Rate limiting service for Telegram API calls
 *
 * Implements window-based rate tracking and flood wait handling
 * as described in docs/rate-limiting.md
 */
import type { Database, Statement } from 'bun:sqlite'
import { ApiActivityRow, RateLimitRow } from './schema'
import type { ApiActivityEntry } from './types'

/** Duration of rate tracking windows in seconds */
export const RATE_WINDOW_SECONDS = 60

/** The span `getStatus` counts calls over, in ms: the last 60 seconds */
export const RECENT_CALLS_MS = 60_000

/**
 * Flood wait information for a blocked method
 */
export interface FloodWaitInfo {
  /** Unix timestamp (seconds) when the block expires */
  blockedUntil: number
  /** Original wait duration in seconds */
  waitSeconds: number
}

/**
 * Rate limit status summary
 */
export interface RateLimitStatus {
  /** API calls logged in api_activity in the last 60 seconds */
  totalCalls: number
  /** The same calls by method */
  callsByMethod: Record<string, number>
  /** Currently active flood waits */
  activeFloodWaits: Array<{
    method: string
    blockedUntil: number
    waitSeconds: number
  }>
}

/**
 * Options for getting API activity
 */
export interface GetActivityOptions {
  /** Filter by method name */
  method?: string
  /** Maximum number of entries to return */
  limit?: number
  /** Only return entries with errors */
  onlyErrors?: boolean
}

export interface RateLimitsOptions {
  /** The current time in ms; tests inject it */
  now?: () => number
}

/**
 * Service for managing rate limits and API activity tracking
 */
export class RateLimitsService {
  /** The current time in ms */
  readonly now: () => number

  private recordCallStmt: Statement
  private getCallCountByMethodStmt: Statement
  private getCallCountAllStmt: Statement
  private setFloodWaitStmt: Statement
  private getFloodWaitStmt: Statement
  private clearExpiredFloodWaitsStmt: Statement
  private logActivityStmt: Statement
  private getActivityStmt: Statement
  private getActivityByMethodStmt: Statement
  private getActivityErrorsStmt: Statement
  private getActivityByMethodErrorsStmt: Statement
  private getRecentCallsStmt: Statement
  private getActiveFloodWaitsStmt: Statement

  constructor(db: Database, options: RateLimitsOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    // Prepare all statements for better performance

    // Record an API call in the current window
    this.recordCallStmt = db.query(`
      INSERT INTO rate_limits (method, window_start, call_count, last_call_at)
      VALUES ($method, $window_start, 1, $now)
      ON CONFLICT(method, window_start) DO UPDATE SET
        call_count = call_count + 1,
        last_call_at = $now
    `)

    // Get call count for a specific method
    this.getCallCountByMethodStmt = db
      .query(
        `
      SELECT COALESCE(SUM(call_count), 0) as total
      FROM rate_limits
      WHERE method = $method AND window_start >= $cutoff
    `,
      )
      .as(
        class Row {
          total!: number
        },
      )

    // Get call count for all methods
    this.getCallCountAllStmt = db
      .query(
        `
      SELECT COALESCE(SUM(call_count), 0) as total
      FROM rate_limits
      WHERE window_start >= $cutoff
    `,
      )
      .as(
        class Row {
          total!: number
        },
      )

    // Set flood wait for a method
    this.setFloodWaitStmt = db.query(`
      INSERT INTO rate_limits (method, window_start, call_count, last_call_at, flood_wait_until)
      VALUES ($method, $window_start, 0, $now, $flood_wait_until)
      ON CONFLICT(method, window_start) DO UPDATE SET
        flood_wait_until = $flood_wait_until
    `)

    // Get flood wait info for a method
    this.getFloodWaitStmt = db
      .query(
        `
      SELECT flood_wait_until, window_start
      FROM rate_limits
      WHERE method = $method AND flood_wait_until IS NOT NULL AND flood_wait_until > $now
      ORDER BY flood_wait_until DESC
      LIMIT 1
    `,
      )
      .as(RateLimitRow)

    // Clear expired flood waits
    this.clearExpiredFloodWaitsStmt = db.query(`
      UPDATE rate_limits
      SET flood_wait_until = NULL
      WHERE flood_wait_until IS NOT NULL AND flood_wait_until <= $now
    `)

    // Log API activity
    this.logActivityStmt = db.query(`
      INSERT INTO api_activity (timestamp, method, success, error_code, response_ms, context)
      VALUES ($timestamp, $method, $success, $error_code, $response_ms, $context)
    `)

    // Get activity - base queries
    this.getActivityStmt = db
      .query(
        `
      SELECT id, timestamp, method, success, error_code, response_ms, context
      FROM api_activity
      ORDER BY timestamp DESC
      LIMIT $limit
    `,
      )
      .as(ApiActivityRow)

    this.getActivityByMethodStmt = db
      .query(
        `
      SELECT id, timestamp, method, success, error_code, response_ms, context
      FROM api_activity
      WHERE method = $method
      ORDER BY timestamp DESC
      LIMIT $limit
    `,
      )
      .as(ApiActivityRow)

    this.getActivityErrorsStmt = db
      .query(
        `
      SELECT id, timestamp, method, success, error_code, response_ms, context
      FROM api_activity
      WHERE success = 0
      ORDER BY timestamp DESC
      LIMIT $limit
    `,
      )
      .as(ApiActivityRow)

    this.getActivityByMethodErrorsStmt = db
      .query(
        `
      SELECT id, timestamp, method, success, error_code, response_ms, context
      FROM api_activity
      WHERE method = $method AND success = 0
      ORDER BY timestamp DESC
      LIMIT $limit
    `,
      )
      .as(ApiActivityRow)

    // Calls by method since a time, for status. The rate windows are
    // calendar minutes; api_activity has each call's own time.
    this.getRecentCallsStmt = db
      .query(
        `
      SELECT method, COUNT(*) as total
      FROM api_activity
      WHERE timestamp >= $cutoff
      GROUP BY method
    `,
      )
      .as(
        class Row {
          method!: string
          total!: number
        },
      )

    // Get active flood waits
    this.getActiveFloodWaitsStmt = db
      .query(
        `
      SELECT method, MAX(flood_wait_until) as flood_wait_until, window_start
      FROM rate_limits
      WHERE flood_wait_until IS NOT NULL AND flood_wait_until > $now
      GROUP BY method
      ORDER BY flood_wait_until ASC
    `,
      )
      .as(RateLimitRow)
  }

  private nowSeconds(): number {
    return Math.floor(this.now() / 1000)
  }

  /**
   * Get the current window start timestamp
   */
  private getCurrentWindowStart(): number {
    const now = this.nowSeconds()
    return Math.floor(now / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS
  }

  /**
   * Record an API call for rate tracking
   */
  recordCall(method: string): void {
    const now = this.nowSeconds()
    const windowStart = this.getCurrentWindowStart()

    this.recordCallStmt.run({
      $method: method,
      $window_start: windowStart,
      $now: now,
    })
  }

  /**
   * Get call count for a method (or all methods) in the last N minutes
   */
  getCallCount(method: string | null, minutes: number): number {
    const now = this.nowSeconds()
    const cutoff = now - minutes * 60

    if (method) {
      const result = this.getCallCountByMethodStmt.get({
        $method: method,
        $cutoff: cutoff,
      }) as { total: number } | null
      return result?.total ?? 0
    }

    const result = this.getCallCountAllStmt.get({ $cutoff: cutoff }) as {
      total: number
    } | null
    return result?.total ?? 0
  }

  /**
   * Set flood wait for a method
   */
  setFloodWait(method: string, seconds: number): void {
    const now = this.nowSeconds()
    const windowStart = this.getCurrentWindowStart()
    const blockedUntil = now + seconds

    this.setFloodWaitStmt.run({
      $method: method,
      $window_start: windowStart,
      $now: now,
      $flood_wait_until: blockedUntil,
    })
  }

  /**
   * Get flood wait info for a method
   */
  getFloodWait(method: string): FloodWaitInfo | null {
    const now = this.nowSeconds()

    const row = this.getFloodWaitStmt.get({
      $method: method,
      $now: now,
    }) as RateLimitRow | null

    if (!row?.flood_wait_until) {
      return null
    }

    // Calculate original wait seconds from window_start
    // The flood_wait_until was set as: window_time + seconds
    // We stored it with the window, so we can approximate
    const waitSeconds = row.flood_wait_until - row.window_start

    return {
      blockedUntil: row.flood_wait_until,
      waitSeconds: waitSeconds > 0 ? waitSeconds : row.flood_wait_until - now,
    }
  }

  /**
   * Check if a method is currently blocked
   */
  isBlocked(method: string): boolean {
    return this.getFloodWait(method) !== null
  }

  /**
   * Clear expired flood waits
   * Returns the number of cleared entries
   */
  clearExpiredFloodWaits(): number {
    const now = this.nowSeconds()
    const result = this.clearExpiredFloodWaitsStmt.run({ $now: now })
    return result.changes
  }

  /**
   * Get time until method is unblocked (0 if not blocked)
   */
  getWaitTime(method: string): number {
    const floodWait = this.getFloodWait(method)
    if (!floodWait) {
      return 0
    }

    const now = this.nowSeconds()
    const remaining = floodWait.blockedUntil - now

    return Math.max(0, remaining)
  }

  /**
   * Log API activity; `timestamp` is when the call started, in ms
   */
  logActivity(entry: {
    timestamp: number
    method: string
    success: number
    error_code?: number | null
    error_message?: string | null
    response_ms?: number | null
    context?: string | null
  }): void {
    this.logActivityStmt.run({
      $timestamp: entry.timestamp,
      $method: entry.method,
      $success: entry.success,
      $error_code: entry.error_code ?? null,
      $response_ms: entry.response_ms ?? null,
      $context: entry.context ?? null,
    })
  }

  /**
   * Get recent API activity
   */
  getActivity(opts: GetActivityOptions = {}): ApiActivityEntry[] {
    const limit = opts.limit ?? 100

    let rows: ApiActivityRow[]

    if (opts.method && opts.onlyErrors) {
      rows = this.getActivityByMethodErrorsStmt.all({
        $method: opts.method,
        $limit: limit,
      }) as ApiActivityRow[]
    } else if (opts.method) {
      rows = this.getActivityByMethodStmt.all({
        $method: opts.method,
        $limit: limit,
      }) as ApiActivityRow[]
    } else if (opts.onlyErrors) {
      rows = this.getActivityErrorsStmt.all({
        $limit: limit,
      }) as ApiActivityRow[]
    } else {
      rows = this.getActivityStmt.all({
        $limit: limit,
      }) as ApiActivityRow[]
    }

    // Map to ApiActivityEntry format
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      method: row.method,
      chat_id: null, // Not stored in current schema
      success: row.success,
      error_code: row.error_code ? Number(row.error_code) : null,
      error_message: row.context, // Using context for error details
      response_ms: row.response_ms,
      request_size: null,
      response_size: null,
    }))
  }

  /**
   * Get rate limit status summary: the calls of the last 60 seconds, from
   * api_activity, and the FLOOD_WAITs still running
   */
  getStatus(): RateLimitStatus {
    const now = this.nowSeconds()

    const methodRows = this.getRecentCallsStmt.all({
      $cutoff: this.now() - RECENT_CALLS_MS,
    }) as Array<{
      method: string
      total: number
    }>
    let totalCalls = 0
    const callsByMethod: Record<string, number> = {}
    for (const row of methodRows) {
      callsByMethod[row.method] = row.total
      totalCalls += row.total
    }

    // Get active flood waits
    const floodWaitRows = this.getActiveFloodWaitsStmt.all({
      $now: now,
    }) as RateLimitRow[]

    const activeFloodWaits = floodWaitRows
      .filter((row) => row.flood_wait_until !== null)
      .map((row) => ({
        method: row.method,
        blockedUntil: row.flood_wait_until!,
        waitSeconds: row.flood_wait_until! - row.window_start,
      }))

    return {
      totalCalls,
      callsByMethod,
      activeFloodWaits,
    }
  }
}

/**
 * Create a rate limits service for a database
 */
export function createRateLimitsService(
  db: Database,
  options?: RateLimitsOptions,
): RateLimitsService {
  return new RateLimitsService(db, options)
}
