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
// Attachments (#22): the file of a cached message, one row per message
// =============================================================================

const MESSAGE_ATTACHMENTS_ANNOTATION: TableAnnotation = {
  description:
    'The file of a cached message (photo, video, voice…), one row per message, written with the message. Messages cached before this table existed get their row from the background migration messages_raw_json_v2 (see cache_migrations); tg messages list/get/search read the attachment from raw_json for every message. Join messages_cache USING (chat_id, message_id).',
  primaryKey: ['chat_id', 'message_id'],
  columns: {
    chat_id: {
      description: 'Marked peer ID of the chat, as in messages_cache',
      nullable: false,
    },
    message_id: {
      description: 'Message ID within the chat',
      nullable: false,
    },
    kind: {
      description: 'What the file is',
      nullable: false,
      semanticType: 'enum',
      enumValues: [
        'photo',
        'video',
        'round',
        'animation',
        'voice',
        'audio',
        'sticker',
        'document',
      ],
    },
    source: {
      description:
        'message: the message media; webpage: the photo or file of its link preview',
      nullable: false,
      semanticType: 'enum',
      enumValues: ['message', 'webpage'],
      defaultValue: 'message',
    },
    file_name: {
      description:
        'File name the sender gave (documents); null for photos and unnamed files',
      nullable: true,
    },
    mime_type: {
      description: 'MIME type (image/jpeg for photos)',
      nullable: true,
    },
    file_size: { description: 'Size in bytes', nullable: true },
    duration: {
      description: 'Length in seconds (video, round, animation, voice, audio)',
      nullable: true,
    },
    width: {
      description: 'Width in pixels (photo: largest size)',
      nullable: true,
    },
    height: { description: 'Height in pixels', nullable: true },
    unique_file_id: {
      description:
        'Telegram unique file ID (same for the same file in any chat); the folder name in the media cache',
      nullable: false,
    },
    grouped_id: {
      description: 'Album ID: messages sent as one album share it',
      nullable: true,
      semanticType: 'bigint_string',
    },
  },
  indexes: {
    idx_message_attachments_unique_file_id:
      'Find the messages that hold a cached file',
  },
}

// =============================================================================
// Content protection (#22): the last online check of a chat's protection
// =============================================================================

const CHAT_CONTENT_PROTECTION_ANNOTATION: TableAnnotation = {
  description:
    "What the last online check of tg media download found about a chat's content protection. A protected chat's cached files are refused offline too, until an online check (--fresh) finds the protection off. Written only by tg media download.",
  primaryKey: 'chat_id',
  columns: {
    chat_id: {
      description: 'Marked peer ID of the chat, as in messages_cache',
      nullable: false,
    },
    protected: {
      description: 'Whether that check found content protection',
      nullable: false,
      semanticType: 'boolean_int',
    },
    reason: {
      description:
        'chat: the group or channel protects its content; private_chat: a private chat with protection on; null when not protected',
      nullable: true,
      semanticType: 'enum',
      enumValues: ['chat', 'private_chat'],
    },
    fetched_at: {
      description: 'When that check ran',
      nullable: false,
      semanticType: 'timestamp',
    },
  },
}

// =============================================================================
// Background migrations (#89): rewrites of every row, done in batches
// =============================================================================

const CACHE_MIGRATIONS_ANNOTATION: TableAnnotation = {
  description:
    'The progress of each background migration: a rewrite of every row of a table that the daemon or tg db migrate does in short batches, resuming from cursor. tg status shows the unfinished ones.',
  primaryKey: 'name',
  columns: {
    name: {
      description:
        'The migration: messages_raw_json_v2, users_raw_json_v2, chats_raw_json_v2',
      nullable: false,
    },
    state: {
      description:
        'pending before it starts, running once it has, done when every row is',
      nullable: false,
      semanticType: 'enum',
      enumValues: ['pending', 'running', 'done'],
    },
    cursor: {
      description: 'rowid of the last row done',
      nullable: false,
    },
    end_rowid: {
      description:
        'The largest rowid of the table when the migration started; later rows are written in the new form',
      nullable: true,
    },
    done: { description: 'Rows done so far', nullable: false },
    total: {
      description: 'Rows up to end_rowid when it started; null until then',
      nullable: true,
    },
    started_at: {
      description: 'When it started',
      nullable: true,
      semanticType: 'timestamp',
    },
    updated_at: {
      description: 'When the last batch ran',
      nullable: true,
      semanticType: 'timestamp',
    },
    finished_at: {
      description: 'When it finished',
      nullable: true,
      semanticType: 'timestamp',
    },
    last_error: {
      description:
        'The error of the last failed batch, which rolled back; cleared by the next batch that commits',
      nullable: true,
    },
  },
}

// =============================================================================
// Schema Registry
// =============================================================================

export const SCHEMA_REGISTRY: SchemaRegistry = {
  version: 5,
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
            'Complete Telegram User object as JSON for future-proofing. Byte arrays are base64 strings and 64-bit values (accessHash…) decimal strings; rows of older versions keep objects until the background migration users_raw_json_v2 reaches them',
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
            'Marked peer ID, as messages_cache.chat_id holds it: the user ID for a private chat, -N for basic group N, -100… for a supergroup, channel or community',
          semanticType: 'bigint_string',
          nullable: false,
        },
        type: {
          description: 'Type of chat',
          enumValues: [
            'private',
            'group',
            'supergroup',
            'channel',
            'community',
          ],
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
          description:
            'Complete Telegram Chat object as JSON. Byte arrays are base64 strings and 64-bit values (accessHash…) decimal strings; rows of older versions keep objects until the background migration chats_raw_json_v2 reaches them',
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
            'Marked peer ID of the sender: a user ID, or -N / -100… for a group or channel that posts as itself. A message Telegram sends without a sender (an incoming private message, a channel post, Saved Messages) has its chat as the sender, as mtcute gives live messages. Null when raw_json names no peer.',
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
          description:
            'Type of message content, as live updates and history sync both write it. Rows history sync wrote in earlier versions say document for every file (voice, video, sticker…) until the background migration messages_raw_json_v2 reaches them',
          enumValues: [
            'text',
            'photo',
            'video',
            'document',
            'sticker',
            'voice',
            'audio',
            'poll',
            'contact',
            'location',
            'venue',
            'game',
            'invoice',
            'webpage',
            'dice',
            'service',
            'unknown',
            'media',
          ],
          semanticType: 'enum',
          defaultValue: 'text',
        },
        has_media: {
          description:
            'Whether the message has media Telegram clients show (a photo, file, poll, location, link preview…); 0 for text, service messages and media the client cannot show',
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
          description: 'When the message was last edited, in Unix seconds',
          semanticType: 'timestamp_sec',
          nullable: true,
        },
        date: {
          description:
            "When the message was originally sent, in Unix seconds (Telegram's own unit): date >= unixepoch('now', '-7 days')",
          semanticType: 'timestamp_sec',
          nullable: false,
        },
        fetched_at: {
          description:
            'When this message was last fetched with a change. Fetching it again unchanged writes nothing, so this keeps the earlier time',
          semanticType: 'timestamp',
          nullable: false,
        },
        raw_json: {
          description:
            'Complete Telegram Message object as JSON, without fileReference. Byte arrays such as the stripped thumbnail are base64 strings and 64-bit values (id, groupedId…) decimal strings; rows of older versions keep objects and fileReference until the background migration messages_raw_json_v2 reaches them',
          semanticType: 'json',
          nullable: false,
        },
        created_at: {
          description: 'When this cache entry was created',
          semanticType: 'timestamp',
        },
        updated_at: {
          description: 'When this cache entry last changed',
          semanticType: 'timestamp',
        },
      },
      indexes: {
        idx_messages_cache_date: 'Order messages chronologically within a chat',
        idx_messages_cache_from: 'Find messages by sender',
        idx_messages_cache_reply: 'Find reply chains',
        idx_messages_cache_type: 'Filter by media type',
        idx_messages_cache_pinned: 'Find pinned messages',
        idx_messages_cache_message_id:
          'Find the chat of a message ID that a delete without chat context names',
      },
    },

    message_attachments: MESSAGE_ATTACHMENTS_ANNOTATION,
    chat_content_protection: CHAT_CONTENT_PROTECTION_ANNOTATION,
    cache_migrations: CACHE_MIGRATIONS_ANNOTATION,

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
        'Full-text search index for messages_cache (FTS5 virtual table). On SQLite 3.43+ it is contentless: its columns read as NULL. Query the view message_search_text for matches with their text.',
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
    // Message Search View
    // -------------------------------------------------------------------------
    message_search_text: {
      description:
        "View: message_search joined with messages_cache, the chat and the sender, so a full-text match comes with its text. SELECT message_id, chat_title, text FROM message_search_text WHERE message_search_text MATCH 'deploy' ORDER BY rank. It stores nothing; snippet() and highlight() don't work on it (tg messages search --snippet does).",
      primaryKey: 'rowid',
      columns: {
        message_search_text: {
          description:
            "The index itself: filter with message_search_text MATCH '<FTS5 query>'",
          nullable: true,
        },
        rank: {
          description:
            'bm25 rank of the match, lower is better: ORDER BY rank puts the best first',
          nullable: true,
        },
        rowid: { description: 'messages_cache rowid' },
        chat_id: { description: 'Marked peer ID of the chat' },
        message_id: { description: 'Message ID within the chat' },
        from_id: {
          description: 'Marked peer ID of the sender (see messages_cache)',
          nullable: true,
        },
        text: { description: 'Message text', nullable: true },
        message_type: { description: 'Type of message content' },
        has_media: {
          description: 'Whether message contains media',
          semanticType: 'boolean_int',
        },
        media_path: { description: 'Local media path', nullable: true },
        is_outgoing: {
          description: 'Whether message was sent by current user',
          semanticType: 'boolean_int',
        },
        is_edited: {
          description: 'Whether message has been edited',
          semanticType: 'boolean_int',
        },
        is_pinned: {
          description: 'Whether message is pinned',
          semanticType: 'boolean_int',
        },
        is_deleted: {
          description: 'Whether message was deleted (soft delete)',
          semanticType: 'boolean_int',
        },
        reply_to_id: {
          description: 'ID of message being replied to',
          nullable: true,
        },
        forward_from_id: {
          description: 'Marked peer ID of the original sender of a forward',
          nullable: true,
        },
        edit_date: {
          description: 'When the message was last edited, in Unix seconds',
          semanticType: 'timestamp_sec',
          nullable: true,
        },
        date: {
          description: 'When the message was sent, in Unix seconds',
          semanticType: 'timestamp_sec',
        },
        fetched_at: {
          description: 'When this message was fetched from API',
          semanticType: 'timestamp',
        },
        chat_title: {
          description: 'Title of the chat (chats_cache)',
          nullable: true,
        },
        chat_username: {
          description: 'Public @username of the chat, without @',
          semanticType: 'username',
          nullable: true,
        },
        chat_type: { description: 'Type of chat', nullable: true },
        sender_username: {
          description: "Sender's @username, without @ (users_cache)",
          semanticType: 'username',
          nullable: true,
        },
        sender_first_name: {
          description: "Sender's first name",
          nullable: true,
        },
        sender_last_name: {
          description: "Sender's last name",
          nullable: true,
        },
      },
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
          description:
            "Cursor for fetching newer data; for contacts: Telegram's saved_count from the last full list",
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
          enumValues: [
            'private',
            'group',
            'supergroup',
            'channel',
            'community',
          ],
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
          description:
            "The chat's message count on the server, from the newest sync page that gave one (a first or history page). NULL until then. tg status compares it with the cached messages",
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
        "Audit log of Telegram API calls: every CLI call and the daemon's history pages and contacts checks. tg status counts the last 60 seconds from it.",
      primaryKey: 'id',
      ttl: '7 days',
      ttlMs: 7 * 24 * 60 * 60 * 1000,
      columns: {
        id: {
          description: 'Auto-incremented log entry ID',
          nullable: false,
        },
        timestamp: {
          description:
            'When the API call started, in ms (0.8.0 and older wrote seconds; the next prune turns them into ms)',
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
          description:
            "Telegram's error code if the call failed (420 for a FLOOD_WAIT); NULL for an error that isn't Telegram's",
          nullable: true,
        },
        response_ms: {
          description: 'API response time in milliseconds',
          nullable: true,
        },
        context: {
          description:
            'Who called (cli:send, daemon:sync, daemon:contacts, ...), or the error message of a failed call',
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
        "Key-value store for the daemon's state for this account (running, connection, progress).",
      primaryKey: 'key',
      columns: {
        key: {
          description:
            'Status key: daemon_pid, daemon_started_at, daemon_status, daemon_version, daemon_version_pid, last_update, connection_status, last_error, messages_synced, pending_jobs, running_jobs, last_catch_up_at, last_catch_up_reason (reconnect, wake, new_client), last_offline_ms, last_catch_up_chats',
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

    // -------------------------------------------------------------------------
    // Cache Metadata Table
    // -------------------------------------------------------------------------
    cache_meta: {
      description:
        'Which account this cache file belongs to. Each account has its own file, accounts/<id>/cache.db; a file stamped for another account is not opened.',
      primaryKey: 'key',
      columns: {
        key: {
          description:
            'account_id (the ID in tg accounts list) or user_id (the Telegram user ID)',
          nullable: false,
          enumValues: ['account_id', 'user_id'],
        },
        value: {
          description: 'The ID, as text',
          nullable: false,
        },
        updated_at: {
          description: 'When the key was written',
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
