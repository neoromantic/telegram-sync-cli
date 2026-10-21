import type { Database } from 'bun:sqlite'
import { defineCommand } from 'citty'
import { getCacheDb } from '../../db'
import { createChatSyncStateService } from '../../db/chat-sync-state'
import { type CachedChat, createChatsCache } from '../../db/chats-cache'
import { createSyncJobsService } from '../../db/sync-jobs'
import {
  determineSyncPolicy,
  type SyncChatType,
  type SyncMode,
} from '../../db/sync-schema'
import { ErrorCodes } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import { isUsernameIdentifier } from '../../utils/identifiers'
import { error, success } from '../../utils/output'
import {
  getCandidateChatIds,
  toChannelIdFromPeerId,
  toMarkedPeerId,
} from '../../utils/telegram-peer-ids'

export interface ResolvedChat {
  /** Raw ID, as `tg chats list` shows it */
  id: number
  /** Marked peer ID, as the sync tables store it */
  peerId: number
  type: SyncChatType
  title: string | null
  username: string | null
  memberCount: number | null
}

function fromCachedChat(chat: CachedChat): ResolvedChat {
  const id = Number(chat.chat_id)
  return {
    id,
    peerId: toMarkedPeerId(id, chat.type),
    type: chat.type,
    title: chat.title,
    username: chat.username,
    memberCount: chat.member_count,
  }
}

/**
 * Find the chat in the cache: by @username, by the raw ID `tg chats list`
 * shows or a marked ID (-100…, -N), then by a marked ID the daemon has sync
 * state for (a chat seen only live).
 */
function resolveChat(db: Database, input: string): ResolvedChat | null {
  const chatsCache = createChatsCache(db)

  if (isUsernameIdentifier(input)) {
    const chat = chatsCache.getByUsername(input)
    return chat ? fromCachedChat(chat) : null
  }

  const id = Number(input)
  if (!Number.isSafeInteger(id) || id === 0) return null

  for (const candidate of getCandidateChatIds(id)) {
    const chat = chatsCache.getById(String(candidate))
    if (chat) return fromCachedChat(chat)
  }

  const state = createChatSyncStateService(db).get(id)
  if (!state) return null
  return {
    id: toChannelIdFromPeerId(id),
    peerId: id,
    type: state.chat_type as SyncChatType,
    title: null,
    username: null,
    memberCount: state.member_count,
  }
}

/**
 * Store the mode and the sync_enabled it means, in one transaction. A mode
 * that changed cancels the chat's pending jobs, so the daemon queues them
 * again at the right priority; a running job finishes.
 *
 * The transaction takes the write lock before its first read (BEGIN
 * IMMEDIATE). A deferred one would read first, and in WAL mode a write
 * after the daemon committed fails at once with SQLITE_BUSY_SNAPSHOT,
 * busy_timeout or not.
 */
export function applySyncMode(
  db: Database,
  chat: ResolvedChat,
  mode: SyncMode,
) {
  const chatSyncState = createChatSyncStateService(db)
  const jobsService = createSyncJobsService(db)

  const apply = db.transaction(() => {
    if (!chatSyncState.get(chat.peerId)) {
      const policy = determineSyncPolicy(chat.type, chat.memberCount)
      chatSyncState.upsert({
        chat_id: chat.peerId,
        chat_type: chat.type,
        member_count: chat.memberCount,
        sync_priority: policy.priority,
        sync_enabled: policy.enabled,
      })
    }

    const changed = chatSyncState.get(chat.peerId)?.sync_mode !== mode
    chatSyncState.setSyncMode(chat.peerId, mode)
    if (changed) {
      jobsService.cancelPendingForChat(chat.peerId)
    }

    return { state: chatSyncState.get(chat.peerId)!, changed }
  })
  return apply.immediate()
}

export const syncChatCommand = defineCommand({
  meta: {
    name: 'sync',
    description:
      'Turn background sync on or off for a chat (on by default; --off, --auto)',
  },
  args: {
    chat: {
      type: 'positional',
      description:
        'Chat: @username, the ID from "tg chats list", or a marked ID (-100…)',
      // Checked in run(): the parser reads a marked ID such as -100… as flags
      required: false,
    },
    off: {
      type: 'boolean',
      description: 'Stop syncing the chat',
      default: false,
    },
    auto: {
      type: 'boolean',
      description:
        'Follow the default policy again (DMs and groups up to 100 members)',
      default: false,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  run({ args, rawArgs }) {
    if (args.off && args.auto) {
      error(ErrorCodes.INVALID_ARGS, 'Use either --off or --auto, not both')
    }
    // One cache serves every account (#17); the selector is only checked.
    resolveAccountSelector(args.account)

    const input = (
      args.chat ?? rawArgs.find((arg) => /^-\d+$/.test(arg))
    )?.trim()
    if (!input) {
      error(
        ErrorCodes.INVALID_ARGS,
        'Missing chat: pass @username or a chat ID',
      )
    }
    const mode: SyncMode = args.off ? 'off' : args.auto ? 'auto' : 'on'

    const db = getCacheDb()
    const chat = resolveChat(db, input)
    if (!chat) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Chat not found in the cache: ${input}`,
        { chat: input },
        'Start the daemon (its dialog pass lists every chat, archived ones too) or run tg chats get --id @username, then retry',
      )
    }

    const { state, changed } = applySyncMode(db, chat, mode)

    success({
      id: chat.id,
      peerId: chat.peerId,
      type: chat.type,
      title: chat.title,
      username: chat.username,
      mode: state.sync_mode,
      syncEnabled: state.sync_enabled === 1,
      historyComplete: state.history_complete === 1,
      syncedMessages: state.synced_messages,
      changed,
    })
  },
})
