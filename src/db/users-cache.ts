/**
 * Users cache service
 * Provides typed access to the users_cache table
 */
import type { Database } from 'bun:sqlite'

import { UserCacheRow } from './schema'

/**
 * Cached user with computed display_name
 */
export interface CachedUser {
  user_id: string
  username: string | null
  first_name: string | null
  last_name: string | null
  display_name: string | null
  phone: string | null
  access_hash: string | null
  is_contact: number
  is_bot: number
  is_premium: number
  fetched_at: number
  created_at: number
  updated_at: number
  raw_json: string
}

/**
 * Input for creating/updating a cached user
 */
export interface UserCacheInput {
  user_id: string
  username?: string | null
  first_name?: string | null
  last_name?: string | null
  phone?: string | null
  access_hash?: string | null
  is_contact?: number
  is_bot?: number
  is_premium?: number
  fetched_at: number
  raw_json: string
}

/**
 * Compute display name from first_name and last_name
 */
function computeDisplayName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | null {
  const parts: string[] = []
  if (firstName) parts.push(firstName)
  if (lastName) parts.push(lastName)
  return parts.length > 0 ? parts.join(' ') : null
}

/**
 * Users cache service
 */
export class UsersCache {
  private statements: ReturnType<typeof createStatements>

  constructor(private db: Database) {
    this.statements = createStatements(db)
  }

  /**
   * Get user by ID
   */
  getById(userId: string): CachedUser | null {
    return this.statements.getById.get({ $user_id: userId }) ?? null
  }

  /**
   * Get user by username (without @)
   */
  getByUsername(username: string): CachedUser | null {
    // Normalize: remove @ if present
    const normalized = username.startsWith('@') ? username.slice(1) : username
    return (
      this.statements.getByUsername.get({
        $username: normalized.toLowerCase(),
      }) ?? null
    )
  }

  /**
   * Get user by phone number
   */
  getByPhone(phone: string): CachedUser | null {
    // Normalize: remove + and spaces
    const normalized = phone.replace(/[\s+\-()]/g, '')
    return this.statements.getByPhone.get({ $phone: normalized }) ?? null
  }

  /**
   * Insert or update user
   */
  upsert(user: UserCacheInput): void {
    const now = Date.now()
    const displayName = computeDisplayName(user.first_name, user.last_name)
    const normalizedUsername = user.username?.toLowerCase() ?? null

    this.statements.upsert.run({
      $user_id: user.user_id,
      $username: normalizedUsername,
      $first_name: user.first_name ?? null,
      $last_name: user.last_name ?? null,
      $display_name: displayName,
      $phone: user.phone ?? null,
      $access_hash: user.access_hash ?? null,
      $is_contact: user.is_contact ?? 0,
      $is_bot: user.is_bot ?? 0,
      $is_premium: user.is_premium ?? 0,
      $fetched_at: user.fetched_at,
      $raw_json: user.raw_json,
      $now: now,
    })
  }

  /**
   * Merge users that a response mentions into the cache. A field the input
   * leaves undefined keeps the stored value (a new row gets null or 0). An
   * input without an access hash is an incomplete record: it fills only
   * the fields it has and keeps the stored raw_json and fetched_at.
   */
  mergeMany(users: UserCacheInput[]): void {
    const transaction = this.db.transaction(() => {
      for (const user of users) {
        const stored = this.getById(user.user_id)
        if (!stored) {
          this.upsert(user)
          continue
        }
        const given = Object.fromEntries(
          Object.entries(user).filter(([, value]) => value !== undefined),
        )
        const complete = user.access_hash !== undefined
        this.upsert({
          user_id: stored.user_id,
          username: stored.username,
          first_name: stored.first_name,
          last_name: stored.last_name,
          phone: stored.phone,
          access_hash: stored.access_hash,
          is_contact: stored.is_contact,
          is_bot: stored.is_bot,
          is_premium: stored.is_premium,
          ...given,
          fetched_at: complete ? user.fetched_at : stored.fetched_at,
          raw_json: complete ? user.raw_json : stored.raw_json,
        })
      }
    })
    transaction()
  }

  /**
   * Bulk upsert multiple users
   */
  upsertMany(users: UserCacheInput[]): void {
    const transaction = this.db.transaction(() => {
      for (const user of users) {
        this.upsert(user)
      }
    })
    transaction()
  }

  /**
   * Search users by query (name, username, phone)
   */
  search(query: string, limit = 50): CachedUser[] {
    const searchPattern = `%${query}%`
    return this.statements.search.all({
      $query: searchPattern,
      $limit: limit,
    })
  }

  /**
   * Get all users
   */
  getAll(opts?: { limit?: number; offset?: number }): CachedUser[] {
    const limit = opts?.limit ?? 100
    const offset = opts?.offset ?? 0
    return this.statements.getAll.all({ $limit: limit, $offset: offset })
  }

  /**
   * Get all cached contacts
   */
  getContacts(): CachedUser[] {
    return this.statements.getContacts.all()
  }

  /**
   * Get stale users
   */
  getStale(ttlMs: number): CachedUser[] {
    const threshold = Date.now() - ttlMs
    return this.statements.getStale.all({ $threshold: threshold })
  }

  /**
   * Delete user from cache
   */
  delete(userId: string): boolean {
    return this.statements.delete.run({ $user_id: userId }).changes > 0
  }

  /**
   * Count total cached users
   */
  count(): number {
    return (this.statements.count.get() as { count: number } | null)?.count ?? 0
  }

  /**
   * Prune old entries
   */
  prune(maxAgeMs: number): number {
    const threshold = Date.now() - maxAgeMs
    return this.statements.prune.run({ $threshold: threshold }).changes
  }
}

/**
 * Create prepared statements for users cache
 */
function createStatements(db: Database) {
  return {
    getById: db
      .query('SELECT * FROM users_cache WHERE user_id = $user_id')
      .as(UserCacheRow),

    getByUsername: db
      .query(
        'SELECT * FROM users_cache WHERE LOWER(username) = $username COLLATE NOCASE',
      )
      .as(UserCacheRow),

    getByPhone: db
      .query('SELECT * FROM users_cache WHERE phone = $phone')
      .as(UserCacheRow),

    upsert: db.query(`
      INSERT INTO users_cache (
        user_id, username, first_name, last_name, display_name,
        phone, access_hash, is_contact, is_bot, is_premium,
        fetched_at, raw_json, created_at, updated_at
      ) VALUES (
        $user_id, $username, $first_name, $last_name, $display_name,
        $phone, $access_hash, $is_contact, $is_bot, $is_premium,
        $fetched_at, $raw_json, $now, $now
      )
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        display_name = excluded.display_name,
        phone = excluded.phone,
        access_hash = excluded.access_hash,
        is_contact = excluded.is_contact,
        is_bot = excluded.is_bot,
        is_premium = excluded.is_premium,
        fetched_at = excluded.fetched_at,
        raw_json = excluded.raw_json,
        updated_at = $now
    `),

    search: db
      .query(`
        SELECT * FROM users_cache
        WHERE display_name LIKE $query
           OR username LIKE $query
           OR phone LIKE $query
           OR first_name LIKE $query
           OR last_name LIKE $query
        ORDER BY display_name ASC
        LIMIT $limit
      `)
      .as(UserCacheRow),

    getAll: db
      .query(`
        SELECT * FROM users_cache
        ORDER BY display_name ASC
        LIMIT $limit OFFSET $offset
      `)
      .as(UserCacheRow),

    getContacts: db
      .query(`
        SELECT * FROM users_cache
        WHERE is_contact = 1
        ORDER BY display_name ASC
      `)
      .as(UserCacheRow),

    getStale: db
      .query(`
        SELECT * FROM users_cache
        WHERE fetched_at < $threshold
        ORDER BY fetched_at ASC
      `)
      .as(UserCacheRow),

    delete: db.query('DELETE FROM users_cache WHERE user_id = $user_id'),

    count: db.query('SELECT COUNT(*) as count FROM users_cache'),

    prune: db.query('DELETE FROM users_cache WHERE fetched_at < $threshold'),
  }
}

/**
 * Create a users cache instance
 */
export function createUsersCache(db: Database): UsersCache {
  return new UsersCache(db)
}
