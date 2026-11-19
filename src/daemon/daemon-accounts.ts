import { join } from "node:path";
import { type DeleteMessageUpdate, networkMiddlewares, TelegramClient } from "@mtcute/bun";
import { createChatSyncStateService } from "../db/chat-sync-state";
import { createChatsCache } from "../db/chats-cache";
import { createMessagesCache } from "../db/messages-cache";
import type { SyncChatType } from "../db/sync-schema";
import { getDefaultConfig, validateConfig } from "../services/telegram";
import { messageTypeOfMediaType } from "../utils/message-type";
import { richMessageText } from "../utils/rich-message";
import { wrapClientCallWithRecordReplay } from "../utils/telegram-record-replay";
import { apiActivityMiddleware } from "./daemon-api-activity";
import { createConnectionWatch, noteConnectionState } from "./daemon-catch-up";
import { handleContactRawUpdate, requestContactsCheckNow } from "./daemon-contacts";
import { type DaemonContext, requestShutdown } from "./daemon-context";
import { accountLabel, routeClientLogs } from "./daemon-logger";
import { daemonPlatform } from "./daemon-platform";
import { rebuildSyncWorker } from "./daemon-scheduler";
import { calculateReconnectDelay, formatError, getErrorMessage } from "./daemon-utils";
import { createUpdateHandlers, type NewMessageData, readInboxFromUpdate } from "./handlers";
import { formatPace } from "./sync-pacing";
import { extractForwardFromId } from "./sync-worker-real-helpers";
import type { AccountConnectionState, AccountEventHandlers } from "./types";

export function resolveRealtimeMessageType(msg: {
  isService?: boolean;
  media?: { type?: string } | null;
}) {
  if (msg.isService) {
    return { messageType: "service", hasMedia: false };
  }

  if (!msg.media) {
    return { messageType: "text", hasMedia: false };
  }

  return { messageType: messageTypeOfMediaType(msg.media.type), hasMedia: true };
}

export function resolveSyncChatType(
  chat:
    | {
        type?: string;
        chatType?: string;
      }
    | null
    | undefined,
) {
  let resolved: SyncChatType | undefined;

  if (chat?.type === "user") {
    resolved = "private";
  } else if (chat?.type === "chat") {
    switch (chat.chatType) {
      case "group":
        resolved = "group";
        break;
      case "supergroup":
      case "gigagroup":
      case "monoforum":
        resolved = "supergroup";
        break;
      case "channel":
        resolved = "channel";
        break;
      case "community":
        resolved = "community";
        break;
      default:
        resolved = "group";
        break;
    }
  }

  return resolved;
}

export async function closeClientSafe(ctx: DaemonContext, client: TelegramClient, reason: string) {
  try {
    await client.destroy();
    ctx.logger.debug(`Closed client (${reason})`);
  } catch (err) {
    ctx.logger.warn(`Failed to close client (${reason}): ${formatError(err)}`);
  }
}

export function setupSignalHandlers(ctx: DaemonContext) {
  if (ctx.runtime.signalHandlersSetup) return;
  ctx.runtime.signalHandlersSetup = true;

  const handleShutdown = (signal: string) => {
    ctx.logger.info(`Received ${signal}, initiating graceful shutdown...`);
    requestShutdown(ctx);
  };

  process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  process.on("SIGINT", () => handleShutdown("SIGINT"));
}

export function setupEventHandlers(ctx: DaemonContext, accountState: AccountConnectionState) {
  const { client, accountId } = accountState;
  if (!client) {
    ctx.logger.warn(`Cannot setup handlers: no client for account ${accountId}`);
    return;
  }
  const rt = ctx.runtime.accounts.get(accountId);
  if (!rt) {
    ctx.logger.warn(`Cannot setup handlers: account ${accountId} has no cache open`);
    return;
  }

  const cacheDb = rt.db;
  const messagesCache = createMessagesCache(cacheDb);
  const chatSyncState = createChatSyncStateService(cacheDb);

  const updateHandlers = createUpdateHandlers({
    db: cacheDb,
    messagesCache,
    chatSyncState,
    chatsCache: createChatsCache(cacheDb),
    logger: ctx.logger,
    onMessagesSynced: (count) => {
      rt.messagesSynced += count;
    },
  });

  const createContext = () => ({
    accountId,
    receivedAt: Date.now(),
  });

  const eventHandlers: AccountEventHandlers = {
    onNewMessage: (msg) => {
      const ctxLocal = createContext();
      const { messageType, hasMedia } = resolveRealtimeMessageType(msg);
      const chatType = resolveSyncChatType(msg.chat);
      const forwardFromId =
        extractForwardFromId((msg.raw ?? {}) as unknown as Record<string, unknown>) ?? undefined;
      const data: NewMessageData = {
        chatId: msg.chat.id,
        chatType,
        memberCount: msg.chat.type === "chat" ? msg.chat.membersCount : undefined,
        messageId: msg.id,
        fromId: msg.sender?.id,
        text: msg.text,
        date: msg.date.getTime() / 1000,
        isOutgoing: msg.isOutgoing,
        replyToId: msg.replyToMessage?.id ?? undefined,
        messageType,
        hasMedia,
        forwardFromId,
        rawMessage: msg.raw,
        rawChat: msg.chat.raw,
      };

      updateHandlers.handleNewMessage(ctxLocal, data).catch((err) => {
        ctx.logger.error(`Error handling new message: ${formatError(err)}`);
      });

      accountState.lastActivity = Date.now();
      ctx.logger.debug(`[Account ${accountId}] New message in chat ${data.chatId}`);
    },

    onEditMessage: (msg) => {
      const ctxLocal = createContext();
      updateHandlers
        .handleEditMessage(ctxLocal, {
          chatId: msg.chat.id,
          messageId: msg.id,
          newText: msg.text || richMessageText(msg.raw) || msg.text,
          editDate: msg.editDate?.getTime() ? msg.editDate.getTime() / 1000 : Date.now() / 1000,
        })
        .catch((err) => {
          ctx.logger.error(`Error handling message edit: ${formatError(err)}`);
        });

      accountState.lastActivity = Date.now();
      ctx.logger.debug(`[Account ${accountId}] Message edited in chat ${msg.chat.id}`);
    },

    onDeleteMessage: (update: DeleteMessageUpdate) => {
      const chatId = update.channelId;
      if (chatId === null) {
        const ctxLocal = createContext();
        updateHandlers
          .handleDeleteMessagesWithoutChat(ctxLocal, {
            messageIds: update.messageIds,
          })
          .then(({ deleted, ambiguous }) => {
            ctx.logger.debug(
              `[Account ${accountId}] Deleted ${deleted} message(s) without chat context`,
            );
            if (ambiguous.length > 0) {
              const shown = ambiguous
                .slice(0, 5)
                .map((a) => `${a.messageId} in ${a.chatIds.join(", ")}`)
                .join("; ");
              const more = ambiguous.length > 5 ? `; ${ambiguous.length - 5} more` : "";
              ctx.logger.warn(
                `[Account ${accountId}] Left ${ambiguous.length} message ID(s) of a delete without chat context unmarked: more than one private chat or basic group has each (${shown}${more})`,
              );
            }
          })
          .catch((err) => {
            ctx.logger.error(`Error handling message deletion: ${formatError(err)}`);
          });

        accountState.lastActivity = Date.now();
        return;
      }

      const ctxLocal = createContext();
      updateHandlers
        .handleDeleteMessages(ctxLocal, {
          chatId,
          messageIds: update.messageIds,
        })
        .catch((err) => {
          ctx.logger.error(`Error handling message deletion: ${formatError(err)}`);
        });

      accountState.lastActivity = Date.now();
      ctx.logger.debug(`[Account ${accountId}] Messages deleted in chat ${chatId}`);
    },

    onRawUpdate: (info) => {
      handleContactRawUpdate(ctx, accountId, cacheDb, info, Date.now());
      const read = readInboxFromUpdate(info.update);
      if (read) {
        updateHandlers.handleReadInbox(createContext(), read).catch((err) => {
          ctx.logger.error(`Error handling a read update: ${formatError(err)}`);
        });
      }
    },

    onConnectionState: (state) => {
      accountState.watch ??= createConnectionWatch();
      noteConnectionState(accountState.watch, state, Date.now());
      ctx.logger.debug(`[Account ${accountId}] Connection: ${state}`);
    },
  };

  client.onNewMessage.add(eventHandlers.onNewMessage);
  client.onEditMessage.add(eventHandlers.onEditMessage);
  client.onDeleteMessage.add(eventHandlers.onDeleteMessage);
  client.onRawUpdate.add(eventHandlers.onRawUpdate);
  client.onConnectionState.add(eventHandlers.onConnectionState);
  accountState.watch ??= createConnectionWatch();

  accountState.updateHandlers = updateHandlers;
  accountState.eventHandlers = eventHandlers;

  ctx.logger.debug(`[Account ${accountId}] Event handlers registered`);
}

export function removeEventHandlers(
  ctx: DaemonContext,
  accountState: AccountConnectionState,
  client = accountState.client,
) {
  const { eventHandlers, accountId } = accountState;

  if (!client || !eventHandlers) {
    return;
  }

  client.onNewMessage.remove(eventHandlers.onNewMessage);
  client.onEditMessage.remove(eventHandlers.onEditMessage);
  client.onDeleteMessage.remove(eventHandlers.onDeleteMessage);
  client.onRawUpdate.remove(eventHandlers.onRawUpdate);
  client.onConnectionState.remove(eventHandlers.onConnectionState);

  accountState.eventHandlers = undefined;
  accountState.updateHandlers = undefined;

  ctx.logger.debug(`[Account ${accountId}] Event handlers removed`);
}

const SYNC_PAGE_METHOD = "messages.getHistory";

const DAEMON_FLOOD_WAIT_MAX_MS = 5 * 60 * 1000;

/**
 * The network middlewares of the account's daemon client. The flood waiter
 * sleeps inside the request; a request given the daemon's stop signal
 * (`ctx.runtime.shutdown`) ends that sleep when the daemon stops (#64).
 * Innermost, every request goes to the account's api_activity (#127), and
 * every FLOOD_WAIT on messages.getHistory slows the account's sync jobs
 * down (#133).
 */
export function daemonNetworkMiddlewares(ctx: DaemonContext, accountId: number) {
  return [
    ...basicDaemonMiddlewares(ctx, accountId),
    apiActivityMiddleware(
      () => ctx.runtime.accounts.get(accountId)?.db ?? null,
      "daemon",
      (method, seconds) => {
        const pacer = ctx.runtime.accounts.get(accountId)?.pacer;
        if (!pacer || method !== SYNC_PAGE_METHOD) return;
        const pace = pacer.recordFloodWait(Date.now(), seconds);
        ctx.logger.info(
          `[Account ${accountId}] ${method}: FLOOD_WAIT of ${seconds}s, history pace down to ${formatPace(pace)} calls/s`,
        );
      },
    ),
  ];
}

function basicDaemonMiddlewares(ctx: DaemonContext, accountId: number) {
  return networkMiddlewares.basic({
    floodWaiter: {
      maxWait: DAEMON_FLOOD_WAIT_MAX_MS,
      maxRetries: 5,
      store: true,
      onBeforeWait: (waitCtx, seconds) => {
        ctx.logger.info(
          `[Account ${accountId}] ${waitCtx.request._}: FLOOD_WAIT, waiting ${seconds}s`,
        );
      },
    },
  });
}

function createDaemonClient(ctx: DaemonContext, accountId: number, sessionPath: string) {
  const telegramConfig = getDefaultConfig();
  const validation = validateConfig(telegramConfig);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const client = new TelegramClient({
    apiId: telegramConfig.apiId,
    apiHash: telegramConfig.apiHash,
    storage: sessionPath,
    platform: daemonPlatform,
    ...(telegramConfig.transport && { transport: telegramConfig.transport }),
    network: { middlewares: daemonNetworkMiddlewares(ctx, accountId) },
  });
  routeClientLogs(client, ctx.logger, ctx.verbosity, `[Account ${accountId}]`);
  wrapClientCallWithRecordReplay(client, {
    accountId,
    dataDir: ctx.dataDir,
  });
  return client;
}

export async function connectAccount(
  ctx: DaemonContext,
  accountId: number,
  phone: string,
  name: string | null,
) {
  const accountState: AccountConnectionState = {
    accountId,
    phone,
    name,
    status: "connecting",
  };
  ctx.state.accounts.set(accountId, accountState);
  const label = () => accountLabel(accountState);

  try {
    const sessionPath = join(ctx.dataDir, `session_${accountId}.db`);
    ctx.logger.debug(`Connecting account ${label()}`);

    const client = createDaemonClient(ctx, accountId, sessionPath);
    accountState.client = client;

    await client.start({
      phone: async () => {
        throw new Error("Interactive login not supported in daemon mode");
      },
      code: async () => {
        throw new Error("Interactive login not supported in daemon mode");
      },
      password: async () => {
        throw new Error("Interactive login not supported in daemon mode");
      },
    });

    const me = await client.getMe();
    accountState.username = me.username;
    ctx.logger.info(`Connected account ${label()}`);

    const existingByUserId = ctx.accountsDb.getByUserId(me.id);
    if (existingByUserId && existingByUserId.id !== accountId) {
      throw new Error(
        `Same Telegram user as account #${existingByUserId.id}. Run tg auth login or tg auth login-qr again to move the session to account #${existingByUserId.id}, or tg accounts remove --id ${accountId}`,
      );
    }
    if (!existingByUserId) {
      const currentAccount = ctx.accountsDb.getById(accountId);
      if (currentAccount && currentAccount.user_id === null) {
        ctx.accountsDb.update(accountId, { user_id: me.id });
        ctx.logger.debug(`Updated user_id for account #${accountId}: ${me.id}`);
      }
    }

    accountState.status = "connected";
    accountState.lastActivity = Date.now();

    setupEventHandlers(ctx, accountState);

    ctx.logger.debug(`[Account ${accountId}] Starting updates...`);
    await client.startUpdatesLoop();
    ctx.logger.info(`[Account ${accountId}] Real-time updates active`);
    requestContactsCheckNow(ctx, accountId, Date.now());

    return true;
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    ctx.logger.error(`Failed to connect account ${label()}: ${getErrorMessage(err)}`);

    await releaseClient(ctx, accountState, "connect failed");

    accountState.status = "error";
    accountState.lastError = errorMessage;

    return false;
  }
}

export function scheduleReconnect(ctx: DaemonContext, accountState: AccountConnectionState) {
  const attempts = (accountState.reconnectAttempts ?? 0) + 1;
  accountState.reconnectAttempts = attempts;

  if (attempts > ctx.reconnectConfig.maxAttempts) {
    ctx.logger.error(
      `Account ${accountLabel(accountState)} exceeded max reconnection attempts (${ctx.reconnectConfig.maxAttempts}). Giving up.`,
    );
    return;
  }

  const delay = calculateReconnectDelay(attempts, ctx.reconnectConfig);
  accountState.nextReconnectAt = Date.now() + delay;

  ctx.logger.info(
    `Scheduling reconnection for ${accountLabel(accountState)} in ${Math.round(delay / 1000)}s (attempt ${attempts}/${ctx.reconnectConfig.maxAttempts})`,
  );
}

async function releaseClient(
  ctx: DaemonContext,
  accountState: AccountConnectionState,
  reason: string,
) {
  const { client, accountId } = accountState;
  if (!client) return;

  accountState.client = undefined;
  const rt = ctx.runtime.accounts.get(accountId);
  if (rt) rt.worker = null;
  await closeClientSafe(ctx, client, reason);

  try {
    removeEventHandlers(ctx, accountState, client);
  } catch (err) {
    ctx.logger.warn(
      `Error removing event handlers for ${accountLabel(accountState)}: ${formatError(err)}`,
    );
  }
}

export async function attemptReconnect(ctx: DaemonContext, accountState: AccountConnectionState) {
  ctx.logger.info(
    `Attempting reconnection for ${accountLabel(accountState)} (attempt ${accountState.reconnectAttempts}/${ctx.reconnectConfig.maxAttempts})`,
  );

  accountState.status = "reconnecting";
  accountState.nextReconnectAt = undefined;

  await releaseClient(ctx, accountState, "reconnecting");

  try {
    const sessionPath = join(ctx.dataDir, `session_${accountState.accountId}.db`);
    ctx.logger.debug(`Reconnecting account ${accountLabel(accountState)}`);

    const client = createDaemonClient(ctx, accountState.accountId, sessionPath);
    accountState.client = client;

    await client.start({
      phone: async () => {
        throw new Error("Interactive login not supported in daemon mode");
      },
      code: async () => {
        throw new Error("Interactive login not supported in daemon mode");
      },
      password: async () => {
        throw new Error("Interactive login not supported in daemon mode");
      },
    });

    const me = await client.getMe();
    accountState.username = me.username;
    ctx.logger.info(`Reconnected account ${accountLabel(accountState)}`);

    const now = Date.now();
    const offlineSince = accountState.watch?.offlineSince;
    accountState.watch = { online: true, lastCatchUpAt: now };

    setupEventHandlers(ctx, accountState);
    await client.startUpdatesLoop();

    accountState.status = "connected";
    accountState.lastActivity = Date.now();
    accountState.reconnectAttempts = 0;
    accountState.lastError = undefined;

    void rebuildSyncWorker(ctx, accountState.accountId, client, {
      reason: "new_client",
      offlineMs: offlineSince === undefined ? null : now - offlineSince,
    });
    requestContactsCheckNow(ctx, accountState.accountId, Date.now());
    ctx.logger.info(`[Account ${accountState.accountId}] Real-time updates active`);

    return true;
  } catch (err) {
    const errorMessage = getErrorMessage(err);
    ctx.logger.error(
      `Reconnection failed for ${accountLabel(accountState)}: ${getErrorMessage(err)}`,
    );

    await releaseClient(ctx, accountState, "reconnect failed");

    accountState.status = "error";
    accountState.lastError = errorMessage;

    scheduleReconnect(ctx, accountState);

    return false;
  }
}

/**
 * Close every account's client once on shutdown. destroy() stops the updates
 * loop, saves the update state and peers, and closes the session file and the
 * Telegram connections; the update handlers stay on until it returns. The
 * clients close in parallel: one slow close doesn't use up the shutdown
 * timeout for the rest.
 */
export async function disconnectAllAccounts(ctx: DaemonContext) {
  ctx.logger.debug("Disconnecting all accounts...");

  await Promise.all(
    Array.from(ctx.state.accounts.values(), async (accountState) => {
      await releaseClient(ctx, accountState, "shutdown");
      accountState.status = "disconnected";
      ctx.logger.debug(`Disconnected account ${accountLabel(accountState)}`);
    }),
  );
}
