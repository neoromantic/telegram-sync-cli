/**
 * Update handlers for processing Telegram events
 * Handles new messages, edits, deletions, and other updates
 */
import type { Database } from 'bun:sqlite'
import type { tl } from '@mtcute/bun'
import { rawPeerToCacheInput } from '../commands/chats/helpers'
import type { ChatSyncStateService } from '../db/chat-sync-state'
import type { ChatsCache } from '../db/chats-cache'
import type {
  DeleteWithoutChatResult,
  MessageInput,
  MessagesCache,
} from '../db/messages-cache'
import { determineSyncPolicy, type SyncChatType } from '../db/sync-schema'
import { bigIntReplacer, formatError } from './daemon-utils'
import type { DaemonLogger } from './types'

/**
 * Context for update processing
 */
export interface UpdateContext {
  /** Account that received the update */
  accountId: number
  /** Timestamp when update was received */
  receivedAt: number
}

/**
 * New message update data
 */
export interface NewMessageData {
  /** Marked peer ID of the chat, as every cache table stores it */
  chatId: number
  chatType?: SyncChatType
  /** Member count of a group, if the update carries it */
  memberCount?: number | null
  messageId: number
  fromId?: number
  text?: string
  date: number
  isOutgoing: boolean
  replyToId?: number
  forwardFromId?: number
  messageType?: string
  hasMedia?: boolean
  isPinned?: boolean
  /** Raw message object from Telegram API for future-proofing */
  rawMessage?: unknown
  /** Raw user or chat the message is in, as the update carries it */
  rawChat?: tl.TypeUser | tl.TypeChat
}

/**
 * Edit message update data
 */
export interface EditMessageData {
  chatId: number
  messageId: number
  newText: string
  editDate: number
}

/**
 * Delete messages update data (with known chat ID, e.g., channels)
 */
export interface DeleteMessagesData {
  chatId: number
  messageIds: number[]
}

/**
 * Delete messages update data without a chat ID. Telegram sends a delete in
 * a private chat or basic group (updateDeleteMessages) with message IDs only.
 * Those IDs come from one sequence per account, so the handler matches them
 * among the account's private chats and basic groups.
 */
export interface DeleteMessagesWithoutChatData {
  messageIds: number[]
}

/**
 * Update handlers interface
 */
export interface UpdateHandlers {
  /** Handle a new message */
  handleNewMessage(_ctx: UpdateContext, data: NewMessageData): Promise<void>
  /** Handle a message edit */
  handleEditMessage(_ctx: UpdateContext, data: EditMessageData): Promise<void>
  /** Handle message deletions (with known chat ID, e.g., channels) */
  handleDeleteMessages(
    _ctx: UpdateContext,
    data: DeleteMessagesData,
  ): Promise<void>
  /** Handle message deletions without chat ID (DMs and basic groups) */
  handleDeleteMessagesWithoutChat(
    _ctx: UpdateContext,
    data: DeleteMessagesWithoutChatData,
  ): Promise<DeleteWithoutChatResult>
  /** Handle a batch of messages (for history sync) */
  handleBatchMessages(
    _ctx: UpdateContext,
    messages: NewMessageData[],
  ): Promise<void>
}

/**
 * Options for creating update handlers
 */
export interface UpdateHandlersOptions {
  db: Database
  messagesCache: MessagesCache
  chatSyncState: ChatSyncStateService
  /** Caches the chat of a message from a chat no dialog pass listed yet */
  chatsCache?: ChatsCache
  logger?: DaemonLogger
  onMessagesSynced?: (count: number) => void
}

interface HandlerDeps {
  messagesCache: MessagesCache
  chatSyncState: ChatSyncStateService
  chatsCache?: ChatsCache
  logger: DaemonLogger
  onMessagesSynced?: (count: number) => void
}

/**
 * Default no-op logger for when logging is not needed
 */
const noopLogger: DaemonLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
}

function toMessageInput(data: NewMessageData): MessageInput {
  return {
    chat_id: data.chatId,
    message_id: data.messageId,
    from_id: data.fromId,
    text: data.text,
    message_type: data.messageType ?? 'text',
    date: data.date,
    is_outgoing: data.isOutgoing,
    reply_to_id: data.replyToId,
    forward_from_id: data.forwardFromId,
    has_media: data.hasMedia,
    is_pinned: data.isPinned,
    raw_json: data.rawMessage
      ? JSON.stringify(data.rawMessage, bigIntReplacer)
      : '{}',
  }
}

function ensureSyncState(
  chatSyncState: ChatSyncStateService,
  chatId: number,
  chatType?: SyncChatType,
  memberCount?: number | null,
): void {
  const existing = chatSyncState.get(chatId)
  if (!existing) {
    const resolvedChatType = chatType ?? 'private'
    const policy = determineSyncPolicy(resolvedChatType, memberCount)
    chatSyncState.upsert({
      chat_id: chatId,
      chat_type: resolvedChatType,
      member_count: memberCount,
      sync_priority: policy.priority,
      sync_enabled: policy.enabled,
    })
  }
}

/**
 * Only dialog passes and some CLI commands fill chats_cache, so a chat new
 * to this run (a new DM, say) has no row there. Without one the sync jobs
 * can't build an InputPeer with its access hash, and its first page would
 * fail until the next dialog pass.
 */
function ensureChatCached(
  chatsCache: ChatsCache | undefined,
  chatId: number,
  rawChat: NewMessageData['rawChat'],
): void {
  if (!chatsCache || !rawChat) return
  if (chatsCache.getById(String(chatId))) return

  const input = rawPeerToCacheInput(rawChat)
  if (input) chatsCache.upsert(input)
}

async function handleNewMessageImpl(deps: HandlerDeps, data: NewMessageData) {
  ensureSyncState(
    deps.chatSyncState,
    data.chatId,
    data.chatType,
    data.memberCount,
  )
  ensureChatCached(deps.chatsCache, data.chatId, data.rawChat)

  const input = toMessageInput(data)
  deps.messagesCache.upsert(input)

  // The forward cursor means "every message up to here is cached", so live
  // updates leave it to the sync jobs: messages that arrived while the
  // daemon was stopped may sit between the cursor and this one.
  deps.chatSyncState.incrementSyncedMessages(data.chatId, 1)
  deps.chatSyncState.updateLastSync(data.chatId, 'forward')
  deps.onMessagesSynced?.(1)
}

async function handleEditMessageImpl(deps: HandlerDeps, data: EditMessageData) {
  deps.messagesCache.updateText(
    data.chatId,
    data.messageId,
    data.newText,
    data.editDate,
  )
}

async function handleDeleteMessagesImpl(
  deps: HandlerDeps,
  data: DeleteMessagesData,
) {
  deps.messagesCache.markDeleted(data.chatId, data.messageIds)
}

function groupMessagesByChat(
  messages: NewMessageData[],
): Map<number, NewMessageData[]> {
  const byChatId = new Map<number, NewMessageData[]>()
  for (const msg of messages) {
    const existing = byChatId.get(msg.chatId) ?? []
    existing.push(msg)
    byChatId.set(msg.chatId, existing)
  }
  return byChatId
}

function updateCursorsForBatch(
  chatSyncState: ChatSyncStateService,
  chatId: number,
  messageIds: number[],
): void {
  const state = chatSyncState.get(chatId)
  if (!state) return

  const maxId = Math.max(...messageIds)
  const minId = Math.min(...messageIds)

  if (state.forward_cursor === null || maxId > state.forward_cursor) {
    chatSyncState.updateCursors(chatId, { forward_cursor: maxId })
  }

  if (state.backward_cursor === null || minId < state.backward_cursor) {
    chatSyncState.updateCursors(chatId, { backward_cursor: minId })
  }
}

function processChatBatch(
  deps: HandlerDeps,
  chatId: number,
  chatMessages: NewMessageData[],
): void {
  const chatType =
    chatMessages.find((message) => message.chatType)?.chatType ?? undefined
  const memberCount = chatMessages.find(
    (message) => message.memberCount,
  )?.memberCount
  ensureSyncState(deps.chatSyncState, chatId, chatType, memberCount)

  const inputs = chatMessages.map(toMessageInput)
  deps.messagesCache.upsertBatch(inputs)

  const messageIds = chatMessages.map((m) => m.messageId)
  updateCursorsForBatch(deps.chatSyncState, chatId, messageIds)
  deps.chatSyncState.incrementSyncedMessages(chatId, chatMessages.length)
  deps.onMessagesSynced?.(chatMessages.length)
}

async function handleBatchMessagesImpl(
  deps: HandlerDeps,
  messages: NewMessageData[],
): Promise<void> {
  if (messages.length === 0) return

  const byChatId = groupMessagesByChat(messages)
  for (const [chatId, chatMessages] of byChatId) {
    try {
      processChatBatch(deps, chatId, chatMessages)
    } catch (err) {
      const messageIds = chatMessages.map((m) => m.messageId)
      deps.logger.error(
        `Failed to handle batch messages: chatId=${chatId}, messageCount=${chatMessages.length}, messageIds=[${messageIds.slice(0, 5).join(',')}${messageIds.length > 5 ? '...' : ''}], error=${formatError(err)}`,
      )
    }
  }
}

function createSafeHandler<T>(
  deps: HandlerDeps,
  label: string,
  handler: (data: T) => Promise<void>,
  logContext: (data: T) => string,
) {
  return async (_ctx: UpdateContext, data: T): Promise<void> => {
    try {
      await handler(data)
    } catch (err) {
      deps.logger.error(
        `Failed to ${label}: ${logContext(data)}, error=${formatError(err)}`,
      )
    }
  }
}

/**
 * Create update handlers
 */
export function createUpdateHandlers(
  options: UpdateHandlersOptions,
): UpdateHandlers {
  const deps: HandlerDeps = {
    messagesCache: options.messagesCache,
    chatSyncState: options.chatSyncState,
    chatsCache: options.chatsCache,
    logger: options.logger ?? noopLogger,
    onMessagesSynced: options.onMessagesSynced,
  }

  return {
    handleNewMessage: createSafeHandler(
      deps,
      'handle new message',
      (data) => handleNewMessageImpl(deps, data),
      (data) => `chatId=${data.chatId}, messageId=${data.messageId}`,
    ),
    handleEditMessage: createSafeHandler(
      deps,
      'handle edit message',
      (data) => handleEditMessageImpl(deps, data),
      (data) => `chatId=${data.chatId}, messageId=${data.messageId}`,
    ),
    handleDeleteMessages: createSafeHandler(
      deps,
      'handle delete messages',
      (data) => handleDeleteMessagesImpl(deps, data),
      (data) =>
        `chatId=${data.chatId}, messageIds=[${data.messageIds.join(',')}]`,
    ),
    handleDeleteMessagesWithoutChat: async (_ctx, data) => {
      return deps.messagesCache.markDeletedByMessageIds(data.messageIds)
    },
    handleBatchMessages: async (_ctx, messages) => {
      await handleBatchMessagesImpl(deps, messages)
    },
  }
}
