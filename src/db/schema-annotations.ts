/**
 * Schema annotation types and registry
 * Provides metadata about database tables and columns for:
 * - CLI help output
 * - Documentation generation
 * - AI/LLM context
 */

/** Metadata for a database column */
export interface ColumnAnnotation {
  /** Human-readable description */
  description: string
  /** Whether this column is nullable */
  nullable?: boolean
  /** Default value if any */
  defaultValue?: string | number | boolean | null
  /** Valid enum values if column is an enum */
  enumValues?: readonly string[]
  /** Semantic type hint (e.g., 'timestamp', 'json', 'phone', 'username') */
  semanticType?: SemanticType
}

/** Metadata for a database table */
export interface TableAnnotation {
  /** Human-readable description */
  description: string
  /** Primary key column(s) */
  primaryKey: string | string[]
  /** Column annotations keyed by column name */
  columns: Record<string, ColumnAnnotation>
  /** Index descriptions */
  indexes?: Record<string, string>
  /** Staleness TTL description (for cache tables) */
  ttl?: string
  /** Staleness TTL in milliseconds */
  ttlMs?: number
}

/** Semantic type hints for special handling */
export type SemanticType =
  | 'timestamp' // Unix timestamp (milliseconds)
  | 'timestamp_sec' // Unix timestamp (seconds)
  | 'json' // JSON-encoded string
  | 'phone' // Phone number with country code
  | 'username' // Telegram @username (without @)
  | 'bigint_string' // BigInt stored as string
  | 'boolean_int' // Boolean stored as INTEGER (0/1)
  | 'enum' // Enum value (use enumValues)

/** Complete schema registry */
export interface SchemaRegistry {
  /** Schema version for tracking changes */
  version: number
  /** Table annotations keyed by table name */
  tables: Record<string, TableAnnotation>
}

// =============================================================================
// Schema Registry
// =============================================================================

export const SCHEMA_REGISTRY: SchemaRegistry = {
  version: 2,
  tables: {
    // -------------------------------------------------------------------------
    // Users Cache Table
    // -------------------------------------------------------------------------
    users_cache: {
      description:
        'Cached Telegram user profiles. Includes contacts, chat participants, and any user encountered.',
      primaryKey: 'user_id',
      ttl: '1 week',
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      columns: {
        user_id: {
          description:
            'Telegram user ID (unique identifier); the same as the chat_id of the private chat with the user',
          semanticType: 'bigint_string',
          nullable: false,
        },
        username: {
          description: 'Telegram @username without the @ symbol',
          semanticType: 'username',
          nullable: true,
        },
        first_name: {
          description: "User's first name as set in their profile",
          nullable: true,
        },
        last_name: {
          description: "User's last name as set in their profile",
          nullable: true,
        },
        display_name: {
          description: 'Combined first + last name for display purposes',
          nullable: true,
        },
        phone: {
          description: 'Phone number (only visible for contacts)',
          semanticType: 'phone',
          nullable: true,
        },
        access_hash: {
          description:
            'Telegram access hash required for API calls to this user',
          semanticType: 'bigint_string',
          nullable: true,
        },
        is_contact: {
          description: 'Whether user is in your contacts list',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        is_bot: {
          description: 'Whether this user is a bot account',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        is_premium: {
          description: 'Whether user has Telegram Premium subscription',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        fetched_at: {
          description:
            'Unix timestamp (ms) when this data was fetched from Telegram API',
          semanticType: 'timestamp',
          nullable: false,
        },
        raw_json: {
          description:
            'Complete Telegram User object as JSON for future-proofing',
          semanticType: 'json',
          nullable: false,
        },
        created_at: {
          description: 'When this cache entry was first created',
          semanticType: 'timestamp',
        },
        updated_at: {
          description: 'When this cache entry was last updated',
          semanticType: 'timestamp',
        },
      },
      indexes: {
        idx_users_cache_username: 'Fast lookup by @username',
        idx_users_cache_phone: 'Fast lookup by phone number',
        idx_users_cache_fetched_at: 'Find stale entries for refresh',
      },
    },

    // -------------------------------------------------------------------------
    // Chats Cache Table
    // -------------------------------------------------------------------------
    chats_cache: {
      description:
        'Cached Telegram chats including private chats, groups, supergroups, and channels.',
      primaryKey: 'chat_id',
      ttl: '1 week',
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      columns: {
        chat_id: {
          description:
            'Marked peer ID, as messages_cache.chat_id holds it: the user ID for a private chat, -N for basic group N, -100… for a supergroup or channel',
          semanticType: 'bigint_string',
          nullable: false,
        },
        type: {
          description: 'Type of chat',
          enumValues: ['private', 'group', 'supergroup', 'channel'],
          semanticType: 'enum',
          nullable: false,
        },
        title: {
          description:
            'Chat title (groups/channels) or user display name (private chats)',
          nullable: true,
        },
        username: {
          description: 'Public @username for the chat if it has one',
          semanticType: 'username',
          nullable: true,
        },
        member_count: {
          description: 'Number of members (groups/channels only)',
          nullable: true,
        },
        access_hash: {
          description: 'Telegram access hash required for API calls',
          semanticType: 'bigint_string',
          nullable: true,
        },
        is_creator: {
          description: 'Whether current user created this chat',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        is_admin: {
          description: 'Whether current user is an admin',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        last_message_id: {
          description: 'ID of the most recent message in this chat',
          nullable: true,
        },
        last_message_at: {
          description: 'Timestamp of the most recent message',
          semanticType: 'timestamp',
          nullable: true,
        },
        fetched_at: {
          description: 'When this chat data was last fetched from Telegram API',
          semanticType: 'timestamp',
          nullable: false,
        },
        raw_json: {
          description: 'Complete Telegram Chat object as JSON',
          semanticType: 'json',
          nullable: false,
        },
        created_at: {
          description: 'When this cache entry was first created',
          semanticType: 'timestamp',
        },
        updated_at: {
          description: 'When this cache entry was last updated',
          semanticType: 'timestamp',
        },
      },
      indexes: {
        idx_chats_cache_username: 'Fast lookup by @username',
        idx_chats_cache_type: 'Filter chats by type',
        idx_chats_cache_fetched_at: 'Find stale entries',
        idx_chats_cache_last_message_at: 'Order by recent activity',
      },
    },

    // -------------------------------------------------------------------------
    // Messages Cache Table
    // -------------------------------------------------------------------------
    messages_cache: {
      description:
        'Cached messages from synchronized chats. Messages are eternal (never considered stale).',
      primaryKey: ['chat_id', 'message_id'],
      columns: {
        chat_id: {
          description:
            'Marked peer ID of the chat: the user ID for a private chat, -N for basic group N, -100… for a supergroup or channel. Joins chats_cache on chats_cache.chat_id = CAST(chat_id AS TEXT)',
          nullable: false,
        },
        message_id: {
          description: 'Message ID within the chat (unique per chat)',
          nullable: false,
        },
        from_id: {
          description:
            'Marked peer ID of the sender: a user ID, or -N / -100… for a group or channel that posts as itself. Null when the message names no sender, such as a channel post fetched from history',
          nullable: true,
        },
        reply_to_id: {
          description: 'ID of message being replied to',
          nullable: true,
        },
        forward_from_id: {
          description:
            'Marked peer ID of the original sender of a forwarded message: a user ID, or -N / -100… for a group or channel',
          nullable: true,
        },
        text: {
          description: 'Message text content (null for media-only messages)',
          nullable: true,
        },
        message_type: {
          description: 'Type of message content',
          enumValues: [
            'text',
            'photo',
            'video',
            'document',
            'sticker',
            'voice',
            'audio',
            'video_note',
            'animation',
            'poll',
            'contact',
            'location',
            'venue',
            'game',
            'invoice',
            'service',
            'unknown',
          ],
          semanticType: 'enum',
          defaultValue: 'text',
        },
        has_media: {
          description: 'Whether message contains downloadable media',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        media_path: {
          description: 'Local file path if media was downloaded',
          nullable: true,
        },
        is_outgoing: {
          description: 'Whether message was sent by current user',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        is_edited: {
          description: 'Whether message has been edited',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        is_pinned: {
          description: 'Whether message is pinned in the chat',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        is_deleted: {
          description: 'Whether message was deleted (soft delete)',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        edit_date: {
          description: 'When the message was last edited',
          semanticType: 'timestamp',
          nullable: true,
        },
        date: {
          description: 'When the message was originally sent',
          semanticType: 'timestamp',
          nullable: false,
        },
        fetched_at: {
          description: 'When this message was fetched from API',
          semanticType: 'timestamp',
          nullable: false,
        },
        raw_json: {
          description: 'Complete Telegram Message object as JSON',
          semanticType: 'json',
          nullable: false,
        },
        created_at: {
          description: 'When this cache entry was created',
          semanticType: 'timestamp',
        },
        updated_at: {
          description: 'When this cache entry was last updated',
          semanticType: 'timestamp',
        },
      },
      indexes: {
        idx_messages_cache_date: 'Order messages chronologically within a chat',
        idx_messages_cache_from: 'Find messages by sender',
        idx_messages_cache_reply: 'Find reply chains',
        idx_messages_cache_type: 'Filter by media type',
        idx_messages_cache_pinned: 'Find pinned messages',
        idx_messages_cache_fetched: 'Track sync progress',
      },
    },

    // -------------------------------------------------------------------------
    // History Ranges Table
    // -------------------------------------------------------------------------
    history_ranges: {
      description:
        'Message ID ranges of a chat that messages_cache holds without a gap. Every cached getHistory page (daemon or CLI) adds the range it covers; touching ranges merge. tg messages list and get read from the cache only inside a range.',
      primaryKey: ['chat_id', 'low'],
      columns: {
        chat_id: {
          description:
            'Marked peer ID of the chat the range belongs to, as in messages_cache',
          nullable: false,
        },
        low: {
          description: 'Lowest message ID of the range (inclusive)',
          nullable: false,
        },
        high: {
          description: 'Highest message ID of the range (inclusive)',
          nullable: false,
        },
        updated_at: {
          description: 'When the range was last recorded or merged',
          semanticType: 'timestamp',
        },
      },
    },

    // -------------------------------------------------------------------------
    // Message Search Index (FTS5)
    // -------------------------------------------------------------------------
    message_search: {
      description:
        'Full-text search index for messages_cache (FTS5 virtual table).',
      primaryKey: 'rowid',
      columns: {
        text: {
          description: 'Indexed message text content',
          nullable: true,
        },
        sender: {
          description: 'Indexed sender tokens (username, name, id)',
          nullable: true,
        },
        chat: {
          description: 'Indexed chat tokens (title, username, id)',
          nullable: true,
        },
        files: {
          description: 'Indexed media path/filename tokens',
          nullable: true,
        },
      },
      indexes: {},
    },

    // -------------------------------------------------------------------------
    // Search Metadata
    // -------------------------------------------------------------------------
    search_meta: {
      description: 'Metadata for search index versioning and rebuilds.',
      primaryKey: 'key',
      columns: {
        key: {
          description: 'Metadata key (e.g., search_index_version)',
          nullable: false,
        },
        value: {
          description: 'Metadata value as string',
          nullable: true,
        },
        updated_at: {
          description: 'Last update time',
          semanticType: 'timestamp',
        },
      },
    },

    // -------------------------------------------------------------------------
    // Sync State Table
    // -------------------------------------------------------------------------
    sync_state: {
      description:
        'Global sync state for entity types (contacts, dialogs). Per-chat state is in chat_sync_state.',
      primaryKey: 'entity_type',
      columns: {
        entity_type: {
          description: 'Type of entity being synced (contacts, dialogs)',
          nullable: false,
        },
        forward_cursor: {
          description: 'Cursor for fetching newer data',
          nullable: true,
        },
        backward_cursor: {
          description: 'Cursor for fetching older data',
          nullable: true,
        },
        is_complete: {
          description: 'Whether historical sync has reached the beginning',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        last_sync_at: {
          description: 'When this entity was last synced',
          semanticType: 'timestamp',
          nullable: true,
        },
        created_at: {
          description: 'When tracking started',
          semanticType: 'timestamp',
        },
        updated_at: {
          description: 'When state was last updated',
          semanticType: 'timestamp',
        },
      },
    },

    // -------------------------------------------------------------------------
    // Chat Sync State Table
    // -------------------------------------------------------------------------
    chat_sync_state: {
      description:
        'Tracks message synchronization progress per chat with dual cursors for bidirectional sync.',
      primaryKey: 'chat_id',
      columns: {
        chat_id: {
          description:
            'Marked peer ID of the chat being synchronized, as in messages_cache',
          nullable: false,
        },
        chat_type: {
          description: 'Type of chat (for sync policy decisions)',
          enumValues: ['private', 'group', 'supergroup', 'channel'],
          semanticType: 'enum',
          nullable: false,
        },
        member_count: {
          description:
            'Member count at time of sync setup (for priority calculation)',
          nullable: true,
        },
        forward_cursor: {
          description:
            'Every message up to this ID is cached; forward catch-up pages up from here. Only sync jobs move it, never live updates. 0: the chat was empty at its first page',
          nullable: true,
        },
        backward_cursor: {
          description: 'Oldest message ID seen (for history backfill)',
          nullable: true,
        },
        sync_priority: {
          description:
            "Sync tier: 1=high (DMs, groups under 20 members), 2=medium (20-100 members), 3=low (not synced unless turned on). Also the priority of the chat's jobs inside each lane",
          enumValues: ['1', '2', '3'],
          defaultValue: 3,
        },
        sync_enabled: {
          description: 'Whether automatic sync is enabled for this chat',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        history_complete: {
          description:
            'Whether full history has been synced (reached beginning)',
          semanticType: 'boolean_int',
          defaultValue: 0,
        },
        total_messages: {
          description: 'Estimated total messages in chat (from Telegram)',
          nullable: true,
        },
        synced_messages: {
          description: 'Number of messages synced so far',
          defaultValue: 0,
        },
        last_forward_sync: {
          description: 'When forward sync (new messages) last ran',
          semanticType: 'timestamp',
          nullable: true,
        },
        last_backward_sync: {
          description: 'When backward sync (history) last ran',
          semanticType: 'timestamp',
          nullable: true,
        },
        created_at: {
          description: 'When sync was first enabled for this chat',
          semanticType: 'timestamp',
        },
        updated_at: {
          description: 'When sync state was last modified',
          semanticType: 'timestamp',
        },
        top_message_id: {
          description:
            'Newest message ID Telegram reported (dialog list or a sync page). NULL: unknown. Catch-up is due while it is NULL or above forward_cursor',
          nullable: true,
        },
        sync_mode: {
          description:
            "Set with tg chats sync: 'auto' follows the sync policy, 'on' and 'off' win over it in every dialog pass",
          enumValues: ['auto', 'on', 'off'],
          semanticType: 'enum',
          defaultValue: 'auto',
        },
      },
      indexes: {
        idx_chat_sync_state_enabled:
          'Find chats with sync enabled, ordered by priority',
        idx_chat_sync_state_priority: 'Order chats by sync priority',
        idx_chat_sync_state_incomplete: 'Find chats with incomplete history',
      },
    },

    // -------------------------------------------------------------------------
    // Sync Jobs Table
    // -------------------------------------------------------------------------
    sync_jobs: {
      description:
        'Job queue for background message synchronization. Jobs run in three lanes that take turns (catch-up, first pages, history), by priority inside a lane.',
      primaryKey: 'id',
      columns: {
        id: {
          description: 'Auto-incremented job ID',
          nullable: false,
        },
        chat_id: {
          description:
            'Marked peer ID of the chat to sync, as in messages_cache',
          nullable: false,
        },
        job_type: {
          description: 'Type of sync operation',
          enumValues: [
            'forward_catchup',
            'initial_load',
            'backward_history',
            'full_sync',
          ],
          semanticType: 'enum',
          nullable: false,
        },
        priority: {
          description:
            "Priority inside the job's lane (lower runs first): the chat's sync tier, or 0 for the first page of a chat turned on with tg chats sync",
          defaultValue: 3,
        },
        status: {
          description:
            "Current job status. 'pending' includes jobs waiting for a retry; a 'failed' job blocks new jobs of its type for its chat until it is deleted",
          enumValues: ['pending', 'running', 'completed', 'failed'],
          semanticType: 'enum',
          defaultValue: 'pending',
        },
        cursor_start: {
          description: 'Starting message ID for this job',
          nullable: true,
        },
        cursor_end: {
          description: 'Ending message ID for this job',
          nullable: true,
        },
        messages_fetched: {
          description: 'Number of messages fetched by this job',
          defaultValue: 0,
        },
        error_message: {
          description:
            'The last error, kept while the job waits for its retry and once it failed',
          nullable: true,
        },
        created_at: {
          description: 'When job was queued',
          semanticType: 'timestamp',
        },
        started_at: {
          description: 'When job started executing',
          semanticType: 'timestamp',
          nullable: true,
        },
        completed_at: {
          description: 'When job finished (success or failure)',
          semanticType: 'timestamp',
          nullable: true,
        },
        attempts: {
          description:
            'Failed tries so far; a FLOOD_WAIT does not count. The fifth failure, or a permanent error, marks the job failed',
          defaultValue: 0,
        },
        next_run_at: {
          description:
            'When a pending job may run (ms since the epoch); 0 means now. Set after a failure or a FLOOD_WAIT',
          semanticType: 'timestamp',
          defaultValue: 0,
        },
      },
      indexes: {
        idx_sync_jobs_priority: 'Get highest priority pending jobs',
        idx_sync_jobs_lane:
          'Next pending job of a lane (job types), by priority, age and id',
        idx_sync_jobs_status: 'Filter jobs by status',
        idx_sync_jobs_chat: 'Find jobs for a specific chat',
      },
    },

    // -------------------------------------------------------------------------
    // Rate Limits Table
    // -------------------------------------------------------------------------
    rate_limits: {
      description:
        'Tracks Telegram API rate limiting to prevent FLOOD_WAIT errors.',
      primaryKey: ['method', 'window_start'],
      columns: {
        method: {
          description: 'Telegram API method name',
          nullable: false,
        },
        window_start: {
          description: 'Start of rate limit window',
          semanticType: 'timestamp',
          nullable: false,
        },
        call_count: {
          description: 'Number of API calls in this window',
          defaultValue: 1,
        },
        last_call_at: {
          description: 'When the last call was made',
          semanticType: 'timestamp',
          nullable: true,
        },
        flood_wait_until: {
          description:
            'If rate limited, when we can retry (from FLOOD_WAIT error)',
          semanticType: 'timestamp',
          nullable: true,
        },
      },
      indexes: {
        idx_rate_limits_method: 'Lookup rate limit by method',
      },
    },

    // -------------------------------------------------------------------------
    // API Activity Table
    // -------------------------------------------------------------------------
    api_activity: {
      description:
        'Audit log of all Telegram API calls for debugging and analytics.',
      primaryKey: 'id',
      ttl: '7 days',
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      columns: {
        id: {
          description: 'Auto-incremented log entry ID',
          nullable: false,
        },
        timestamp: {
          description: 'When the API call was made',
          semanticType: 'timestamp',
          nullable: false,
        },
        method: {
          description: 'Telegram API method that was called',
          nullable: false,
        },
        success: {
          description: 'Whether the call succeeded',
          semanticType: 'boolean_int',
          nullable: false,
        },
        error_code: {
          description: 'Telegram error code if call failed',
          nullable: true,
        },
        response_ms: {
          description: 'API response time in milliseconds',
          nullable: true,
        },
        context: {
          description: 'Additional context (e.g., chat_id, user_id)',
          semanticType: 'json',
          nullable: true,
        },
      },
      indexes: {
        idx_api_activity_timestamp: 'Query by time range',
        idx_api_activity_method: 'Filter by API method',
      },
    },

    // -------------------------------------------------------------------------
    // Daemon Status Table
    // -------------------------------------------------------------------------
    daemon_status: {
      description:
        'Key-value store for daemon state (running, last activity, etc).',
      primaryKey: 'key',
      columns: {
        key: {
          description:
            'Status key: daemon_status, daemon_pid, daemon_started_at, daemon_version, daemon_version_pid, connected_accounts, total_accounts, messages_synced, last_update, pending_jobs, running_jobs',
          nullable: false,
        },
        value: {
          description: 'Status value (JSON-encoded for complex values)',
          semanticType: 'json',
          nullable: true,
        },
        updated_at: {
          description: 'When this status was last updated',
          semanticType: 'timestamp',
        },
      },
    },
  },
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Get annotation for a specific table
 */
export function getTableAnnotation(
  tableName: string,
): TableAnnotation | undefined {
  return SCHEMA_REGISTRY.tables[tableName]
}

/**
 * Get annotation for a specific column
 */
export function getColumnAnnotation(
  tableName: string,
  columnName: string,
): ColumnAnnotation | undefined {
  return SCHEMA_REGISTRY.tables[tableName]?.columns[columnName]
}

/**
 * Get all table names
 */
export function getTableNames(): string[] {
  return Object.keys(SCHEMA_REGISTRY.tables)
}

/**
 * Get column names for a table
 */
export function getColumnNames(tableName: string): string[] {
  const table = SCHEMA_REGISTRY.tables[tableName]
  return table ? Object.keys(table.columns) : []
}
