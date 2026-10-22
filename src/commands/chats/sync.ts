import type { Database } from 'bun:sqlite'
import { defineCommand } from 'citty'
import { createChatSyncStateService } from '../../db/chat-sync-state'
import { type CachedChat, createChatsCache } from '../../db/chats-cache'
import { createSyncJobsService } from '../../db/sync-jobs'
import {
  determineSyncPolicy,
  type SyncChatType,
  type SyncMode,
} from '../../db/sync-schema'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { isUsernameIdentifier } from '../../utils/identifiers'
import { error, success } from '../../utils/output'
import { AmbiguousPeerError } from '../send/peer-resolver'
import { findCachedChatById } from './lookup'

export interface ResolvedChat {
  /** Marked peer ID, as `tg chats list` shows it and every cache table stores it */
  id: number
  /** The same marked ID; kept for scripts written against 0.2.0 */
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
    peerId: id,
    type: chat.type,
    title: chat.title,
    username: chat.username,
    memberCount: chat.member_count,
  }
}

/**
 * Find the chat in the cache: by @username, by an ID as findCachedChatById
 * reads it (the marked ID `tg chats list` shows, a user's private chat, or a
 * bare group or channel ID as 0.2.0 showed it), then by an ID the daemon has
 * sync state for (a chat seen only live). A bare ID that names two cached
 * chats throws AmbiguousPeerError.
 */
function resolveChat(db: Database, input: string): ResolvedChat | null {
  if (isUsernameIdentifier(input)) {
    const chat = createChatsCache(db).getByUsername(input)
    return chat ? fromCachedChat(chat) : null
  }

  const cached = findCachedChatById(db, input)
  if (cached) return fromCachedChat(cached)

  if (!/^-?\d+$/.test(input)) return null
  const id = Number(input)
  const state = createChatSyncStateService(db).get(id)
  if (!state) return null
  return {
    id,
    peerId: id,
    type: state.chat_type as SyncChatType,
    title: null,
    username: null,
    memberCount: state.member_count,
  }
}

function resolveChatOrFail(db: Database, input: string): ResolvedChat | null {
  try {
    return resolveChat(db, input)
  } catch (err) {
    if (err instanceof AmbiguousPeerError) {
      error(ErrorCodes.INVALID_ARGS, err.message, {
        chat: input,
        candidates: err.candidates,
      })
    }
    throw err
  }
}

/**
 * Store the mode and the sync_enabled it means, in one transaction. A mode
 * that changed cancels the chat's pending jobs, so the daemon queues them
 * again at the right priority; a running job finishes. Whatever the mode,
 * the chat's failed jobs are deleted: a failed job keeps the daemon from
 * queueing its chat again, so running the command again retries them.
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
    const clearedFailedJobs = jobsService.deleteFailed(chat.peerId)

    return {
      state: chatSyncState.get(chat.peerId)!,
      changed,
      clearedFailedJobs,
    }
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
        'Chat: @username or the ID from "tg chats list" (-100… for channels, -N for basic groups)',
      // Checked in run(): the parser reads a marked ID such as -100… as flags
      required: false,
    },
    off: {
      type: 'boolean',
      description:
        'Stop catch-up and history for the chat (live messages are still cached)',
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
    // The parser reads a marked ID such as -100… as flags and takes the
    // value of a flag it doesn't know (the global --format pretty) as the
    // positional, so a marked ID in rawArgs wins
    const input = (
      rawArgs.find((arg) => /^-\d+$/.test(arg)) ?? args.chat
    )?.trim()
    if (!input) {
      error(
        ErrorCodes.INVALID_ARGS,
        'Missing chat: pass @username or a chat ID',
      )
    }
    const mode: SyncMode = args.off ? 'off' : args.auto ? 'auto' : 'on'

    const { account, db } = openAccountCache(args.account)
    const chat = resolveChatOrFail(db, input)
    if (!chat) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Chat not found in the cache: ${input}`,
        { chat: input, account_id: account.id },
        'Start the daemon (its dialog pass lists every chat, archived ones too) or run tg chats get --id @username, then retry',
      )
    }

    // A community only groups linked chats: there is no history to fetch,
    // so jobs for it would only fail (#58)
    if (mode === 'on' && chat.type === 'community') {
      // 0.4 turned a community on, and its jobs keep failing until it's off
      const turnedOn =
        createChatSyncStateService(db).get(chat.peerId)?.sync_mode === 'on'
      error(
        ErrorCodes.INVALID_ARGS,
        `${chat.title ?? input} is a Telegram community: it has no messages of its own, so there is nothing to sync`,
        { chat: input, id: chat.id, type: 'community', account_id: account.id },
        `Its linked chats are ordinary supergroups and channels: find them with tg chats list --type supergroup or --type channel and turn each on with tg chats sync <chat>${turnedOn ? `. An earlier version turned this community on: tg chats sync ${input} --auto turns it off and clears its failed jobs` : ''}`,
      )
    }

    const { state, changed, clearedFailedJobs } = applySyncMode(db, chat, mode)

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
      clearedFailedJobs,
    })
  },
})
