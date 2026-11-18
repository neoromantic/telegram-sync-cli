import type { Database } from "bun:sqlite";
import type { tl } from "@mtcute/bun";
import { rawPeerToCacheInput } from "../commands/chats/helpers";
import type { ChatSyncStateService } from "../db/chat-sync-state";
import type { ChatsCache } from "../db/chats-cache";
import type { DeleteWithoutChatResult, MessagesCache } from "../db/messages-cache";
import { createSyncJobsService, type SyncJobsService } from "../db/sync-jobs";
import { determineSyncPolicy, rawUserPolicy, type SyncChatType } from "../db/sync-schema";
import { toRawJson } from "../utils/raw-json";
import { toPeerIdFromRawPeer } from "../utils/telegram-peer-ids";
import { formatError } from "./daemon-utils";
import type { DaemonLogger } from "./types";

/**
 * Context for update processing
 */
export interface UpdateContext {
  /** Account that received the update */
  accountId: number;
  /** Timestamp when update was received */
  receivedAt: number;
}

/**
 * New message update data
 */
export interface NewMessageData {
  /** Marked peer ID of the chat, as every cache table stores it */
  chatId: number;
  chatType?: SyncChatType;
  /** Member count of a group, if the update carries it */
  memberCount?: number | null;
  messageId: number;
  fromId?: number;
  text?: string;
  date: number;
  isOutgoing: boolean;
  replyToId?: number;
  forwardFromId?: number;
  messageType?: string;
  hasMedia?: boolean;
  isPinned?: boolean;
  /** Raw message object from Telegram API for future-proofing */
  rawMessage?: unknown;
  /** Raw user or chat the message is in, as the update carries it */
  rawChat?: tl.TypeUser | tl.TypeChat;
}

/**
 * Edit message update data
 */
export interface EditMessageData {
  chatId: number;
  messageId: number;
  newText: string;
  editDate: number;
}

/**
 * Delete messages update data (with known chat ID, e.g., channels)
 */
export interface DeleteMessagesData {
  chatId: number;
  messageIds: number[];
}

/**
 * Delete messages update data without a chat ID. Telegram sends a delete in
 * a private chat or basic group (updateDeleteMessages) with message IDs only.
 * Those IDs come from one sequence per account, so the handler matches them
 * among the account's private chats and basic groups.
 */
export interface DeleteMessagesWithoutChatData {
  messageIds: number[];
}

/**
 * The account read a chat's incoming messages up to `maxId`, here or on
 * another device (updateReadHistoryInbox, updateReadChannelInbox)
 */
export interface ReadInboxData {
  chatId: number;
  maxId: number;
  stillUnreadCount: number;
}

/**
 * The read state a raw update carries, or null for any other update. A read
 * within one forum topic says nothing about the whole chat, so it is null.
 */
export function readInboxFromUpdate(update: tl.TypeUpdate) {
  if (update._ === "updateReadHistoryInbox") {
    if (update.topMsgId) return null;
    const chatId = toPeerIdFromRawPeer(update.peer);
    if (chatId === null) return null;
    return {
      chatId,
      maxId: update.maxId,
      stillUnreadCount: update.stillUnreadCount,
    };
  }
  if (update._ === "updateReadChannelInbox") {
    const chatId = toPeerIdFromRawPeer({
      _: "peerChannel",
      channelId: update.channelId,
    });
    if (chatId === null) return null;
    return {
      chatId,
      maxId: update.maxId,
      stillUnreadCount: update.stillUnreadCount,
    };
  }
  return null;
}

/**
 * Update handlers interface
 */
export interface UpdateHandlers {
  /** Handle a new message */
  handleNewMessage(_ctx: UpdateContext, data: NewMessageData): Promise<void>;
  /** Handle a message edit */
  handleEditMessage(_ctx: UpdateContext, data: EditMessageData): Promise<void>;
  /** Handle message deletions (with known chat ID, e.g., channels) */
  handleDeleteMessages(_ctx: UpdateContext, data: DeleteMessagesData): Promise<void>;
  /** Handle message deletions without chat ID (DMs and basic groups) */
  handleDeleteMessagesWithoutChat(
    _ctx: UpdateContext,
    data: DeleteMessagesWithoutChatData,
  ): Promise<DeleteWithoutChatResult>;
  /** Handle a read of a chat's incoming messages */
  handleReadInbox(_ctx: UpdateContext, data: ReadInboxData): Promise<void>;
}

/**
 * Options for creating update handlers
 */
export interface UpdateHandlersOptions {
  db: Database;
  messagesCache: MessagesCache;
  chatSyncState: ChatSyncStateService;
  /** Caches the chat of a message from a chat no dialog pass listed yet */
  chatsCache?: ChatsCache;
  logger?: DaemonLogger;
  onMessagesSynced?: (count: number) => void;
}

interface HandlerDeps {
  messagesCache: MessagesCache;
  chatSyncState: ChatSyncStateService;
  jobsService: SyncJobsService;
  chatsCache?: ChatsCache;
  logger: DaemonLogger;
  onMessagesSynced?: (count: number) => void;
  loggedEmptyRaw: boolean;
}

const noopLogger: DaemonLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

function liveMessageInput(deps: HandlerDeps, data: NewMessageData) {
  const input = toMessageInput(data);
  if (data.rawMessage) return input;

  if (!deps.loggedEmptyRaw) {
    deps.loggedEmptyRaw = true;
    deps.logger.warn(
      `A live message came without its raw form (chat ${data.chatId}); it is cached with raw_json '{}' and fetched again later`,
    );
  }
  deps.jobsService.queueRefetch(data.chatId);
  return input;
}

function toMessageInput(data: NewMessageData) {
  return {
    chat_id: data.chatId,
    message_id: data.messageId,
    from_id: data.fromId,
    text: data.text,
    message_type: data.messageType ?? "text",
    date: data.date,
    is_outgoing: data.isOutgoing,
    reply_to_id: data.replyToId,
    forward_from_id: data.forwardFromId,
    has_media: data.hasMedia,
    is_pinned: data.isPinned,
    raw_json: data.rawMessage ? toRawJson(data.rawMessage) : "{}",
  };
}

function ensureSyncState(
  chatSyncState: ChatSyncStateService,
  chatId: number,
  chatType?: SyncChatType,
  memberCount?: number | null,
  rawChat?: NewMessageData["rawChat"],
) {
  const existing = chatSyncState.get(chatId);
  if (!existing) {
    const resolvedChatType = chatType ?? "private";
    const policy = determineSyncPolicy(resolvedChatType, memberCount, rawUserPolicy(rawChat));
    chatSyncState.upsert({
      chat_id: chatId,
      chat_type: resolvedChatType,
      member_count: memberCount,
      sync_priority: policy.priority,
      sync_enabled: policy.enabled,
      sync_policy: policy.reason,
    });
  }
}

function ensureChatCached(chatsCache: ChatsCache | undefined, data: NewMessageData) {
  const { chatId, rawChat } = data;
  if (!chatsCache || !rawChat) return;
  if (chatsCache.getById(String(chatId))) return;

  const input = rawPeerToCacheInput(rawChat);
  if (input) {
    chatsCache.upsert({
      ...input,
      unread_count: 0,
      read_inbox_max_id: data.messageId - 1,
    });
  }
}

async function handleNewMessageImpl(deps: HandlerDeps, data: NewMessageData) {
  ensureSyncState(deps.chatSyncState, data.chatId, data.chatType, data.memberCount, data.rawChat);
  ensureChatCached(deps.chatsCache, data);

  const { inserted } = deps.messagesCache.upsert(liveMessageInput(deps, data));
  deps.chatsCache?.noteLiveMessage(String(data.chatId), {
    id: data.messageId,
    date: data.date * 1000,
    incoming: !data.isOutgoing,
  });
  if (inserted === 0) return;

  deps.chatSyncState.incrementSyncedMessages(data.chatId, inserted);
  deps.chatSyncState.updateLastSync(data.chatId, "forward");
  deps.onMessagesSynced?.(inserted);
}

async function handleEditMessageImpl(deps: HandlerDeps, data: EditMessageData) {
  deps.messagesCache.updateText(data.chatId, data.messageId, data.newText, data.editDate);
}

async function handleDeleteMessagesImpl(deps: HandlerDeps, data: DeleteMessagesData) {
  deps.messagesCache.markDeleted(data.chatId, data.messageIds);
}

function createSafeHandler<T>(
  deps: HandlerDeps,
  label: string,
  handler: (data: T) => Promise<void>,
  logContext: (data: T) => string,
) {
  return async (_ctx: UpdateContext, data: T) => {
    try {
      await handler(data);
    } catch (err) {
      deps.logger.error(`Failed to ${label}: ${logContext(data)}, error=${formatError(err)}`);
    }
  };
}

/**
 * Create update handlers
 */
export function createUpdateHandlers(options: UpdateHandlersOptions) {
  const deps: HandlerDeps = {
    messagesCache: options.messagesCache,
    chatSyncState: options.chatSyncState,
    jobsService: createSyncJobsService(options.db),
    chatsCache: options.chatsCache,
    logger: options.logger ?? noopLogger,
    onMessagesSynced: options.onMessagesSynced,
    loggedEmptyRaw: false,
  };

  const result: UpdateHandlers = {
    handleNewMessage: createSafeHandler(
      deps,
      "handle new message",
      (data) => handleNewMessageImpl(deps, data),
      (data) => `chatId=${data.chatId}, messageId=${data.messageId}`,
    ),
    handleEditMessage: createSafeHandler(
      deps,
      "handle edit message",
      (data) => handleEditMessageImpl(deps, data),
      (data) => `chatId=${data.chatId}, messageId=${data.messageId}`,
    ),
    handleDeleteMessages: createSafeHandler(
      deps,
      "handle delete messages",
      (data) => handleDeleteMessagesImpl(deps, data),
      (data) => `chatId=${data.chatId}, messageIds=[${data.messageIds.join(",")}]`,
    ),
    handleDeleteMessagesWithoutChat: async (_ctx, data) => {
      return deps.messagesCache.markDeletedByMessageIds(data.messageIds);
    },
    handleReadInbox: createSafeHandler(
      deps,
      "handle read inbox",
      async (data) => {
        deps.chatsCache?.setReadInbox(String(data.chatId), data.maxId, data.stillUnreadCount);
      },
      (data) => `chatId=${data.chatId}, maxId=${data.maxId}`,
    ),
  };
  return result;
}
