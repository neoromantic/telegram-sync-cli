import type { Dialog, TelegramClient, tl } from '@mtcute/bun'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { getCacheDb } from '../db'
import {
  type ChatSyncStateService,
  createChatSyncStateService,
} from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { determineSyncPolicy, type SyncChatType } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { apiUserToCacheInput } from '../utils/telegram-mappers'
import { toPeerIdFromRawPeer } from '../utils/telegram-peer-ids'
import type { DaemonContext } from './daemon-context'
import { formatError } from './daemon-utils'

const DIALOG_BOOTSTRAP_BATCH_SIZE = 200

export interface DialogPassResult {
  /** Marked peer IDs of every dialog the pass listed */
  visited: Set<number>
  /** The pass listed every dialog without an error */
  complete: boolean
}

/**
 * One pass over an account's dialogs, archived ones included. Every dialog
 * updates `chats_cache`, so the sync jobs can build an InputPeer for it. A
 * dialog also updates the chat's sync state (type, member count, policy and
 * the newest message ID), but an archived chat without a state row gets none:
 * archived chats don't start syncing unless `tg chats sync` turns them on.
 */
export async function syncAccountDialogs(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
): Promise<DialogPassResult> {
  const cacheDb = getCacheDb()
  const chatsCache = createChatsCache(cacheDb)
  const usersCache = createUsersCache(cacheDb)
  const chatSyncState = createChatSyncStateService(cacheDb)

  ctx.logger.info(`[Account ${accountId}] Bootstrapping dialogs...`)
  const start = Date.now()

  const visited = new Set<number>()
  const chatsBatch = [] as ReturnType<typeof dialogToCacheInput>[]
  const usersBatch = [] as ReturnType<typeof apiUserToCacheInput>[]
  let dialogsCount = 0
  let archivedCount = 0
  let usersCount = 0
  let complete = false

  const flushChats = () => {
    if (chatsBatch.length > 0) {
      chatsCache.upsertMany(chatsBatch.splice(0, chatsBatch.length))
    }
  }
  const flushUsers = () => {
    if (usersBatch.length > 0) {
      const batch = usersBatch.splice(0, usersBatch.length)
      usersCache.upsertMany(batch)
      usersCount += batch.length
    }
  }

  const onDialog = (dialog: Dialog) => {
    dialogsCount++
    const chatInput = dialogToCacheInput(dialog)
    chatsBatch.push(chatInput)
    if (chatsBatch.length >= DIALOG_BOOTSTRAP_BATCH_SIZE) flushChats()

    if (dialog.peer.type === 'user' && dialog.peer.raw) {
      usersBatch.push(apiUserToCacheInput(dialog.peer.raw as tl.RawUser))
      if (usersBatch.length >= DIALOG_BOOTSTRAP_BATCH_SIZE) flushUsers()
    }

    const rawPeer = dialog.raw?.peer as
      | { _?: string; userId?: number; chatId?: number; channelId?: number }
      | undefined
    const chatId =
      toPeerIdFromRawPeer(rawPeer ?? null) ?? Number(chatInput.chat_id)
    visited.add(chatId)

    const existing = chatSyncState.get(chatId)
    if (dialog.isArchived) {
      archivedCount++
      if (!existing) return
    }

    // Dialogs often leave the member count out; the stored one keeps a
    // chat from flipping on or off between starts.
    const syncType = chatInput.type as SyncChatType
    const memberCount = chatInput.member_count ?? existing?.member_count ?? null
    const policy = determineSyncPolicy(syncType, memberCount)

    chatSyncState.upsert({
      chat_id: chatId,
      chat_type: syncType,
      member_count: memberCount,
      sync_priority: policy.priority,
      sync_enabled: policy.enabled,
    })

    const topMessage = dialog.raw?.topMessage
    if (topMessage && topMessage > 0) {
      chatSyncState.raiseTopMessageId(chatId, topMessage)
    }
  }

  try {
    for await (const dialog of client.iterDialogs({ archived: 'keep' })) {
      onDialog(dialog)
    }
    complete = true
  } catch (err) {
    ctx.logger.warn(
      `[Account ${accountId}] Failed to bootstrap dialogs after ${dialogsCount}: ${formatError(err)}`,
    )
  }

  // Keep what the pass listed before an error, too.
  flushChats()
  flushUsers()

  if (complete) {
    const elapsedMs = Date.now() - start
    ctx.logger.info(
      `[Account ${accountId}] Bootstrapped ${dialogsCount} dialogs (${archivedCount} archived), ${usersCount} users in ${Math.round(elapsedMs / 1000)}s`,
    )
  }

  return { visited, complete }
}

/**
 * Enabled chats with a cursor that no pass listed. A complete pass over
 * every account lists every chat the user is still in, so the others were
 * left, deleted or migrated: there is nothing to catch up. After an
 * incomplete pass their newest message is unknown, so each gets one page.
 */
function markUnvisitedChats(
  chatSyncState: ChatSyncStateService,
  visited: Set<number>,
  everyPassComplete: boolean,
): number {
  const unvisited = chatSyncState
    .getEnabledWithCursor()
    .map((chat) => chat.chat_id)
    .filter((chatId) => !visited.has(chatId))

  if (everyPassComplete) {
    chatSyncState.markCaughtUp(unvisited)
  } else {
    chatSyncState.markTopUnknown(unvisited)
  }
  return unvisited.length
}

/**
 * The startup dialog pass, one per connected account. It seeds
 * `chats_cache` and `chat_sync_state` and tells the scheduler which chats
 * are behind.
 */
export async function bootstrapDialogs(ctx: DaemonContext): Promise<void> {
  const visited = new Set<number>()
  let everyPassComplete = true

  for (const [accountId, accountState] of ctx.state.accounts) {
    if (accountState.status !== 'connected' || !accountState.client) {
      everyPassComplete = false
      continue
    }

    const result = await syncAccountDialogs(ctx, accountId, accountState.client)
    for (const chatId of result.visited) visited.add(chatId)
    if (!result.complete) everyPassComplete = false
  }

  const chatSyncState = createChatSyncStateService(getCacheDb())
  const unvisited = markUnvisitedChats(
    chatSyncState,
    visited,
    everyPassComplete,
  )
  if (unvisited > 0) {
    ctx.logger.debug(
      everyPassComplete
        ? `${unvisited} synced chat(s) are no longer in any dialog list`
        : `${unvisited} synced chat(s) were not listed; checking each for new messages`,
    )
  }
}

/**
 * After a reconnect, list the account's dialogs on the new client, so the
 * scheduler catches up the chats that got messages while the connection was
 * down. Runs in the background, one pass per account at a time.
 */
export async function refreshDialogsAfterReconnect(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
): Promise<void> {
  if (ctx.runtime.dialogPassesInFlight.has(accountId)) return
  ctx.runtime.dialogPassesInFlight.add(accountId)

  try {
    const { visited, complete } = await syncAccountDialogs(
      ctx,
      accountId,
      client,
    )
    // Every account shares one cache (#17), so unvisited chats may belong
    // to another account; checking them all is a safe superset. A complete
    // pass says nothing about other accounts' chats, so it marks nothing.
    if (!complete) {
      markUnvisitedChats(
        createChatSyncStateService(getCacheDb()),
        visited,
        false,
      )
    }
    ctx.runtime.scheduler?.refreshQueues()
  } catch (err) {
    ctx.logger.warn(
      `[Account ${accountId}] Dialog pass after reconnect failed: ${formatError(err)}`,
    )
  } finally {
    ctx.runtime.dialogPassesInFlight.delete(accountId)
  }
}
