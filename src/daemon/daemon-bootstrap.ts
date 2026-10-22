import type { Dialog, TelegramClient, tl } from '@mtcute/bun'
import {
  dialogToCacheInput,
  fetchJoinedCommunities,
} from '../commands/chats/helpers'
import {
  type ChatSyncStateService,
  createChatSyncStateService,
} from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { determineSyncPolicy, type SyncChatType } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { apiUserToCacheInput } from '../utils/telegram-mappers'
import type { AccountRuntime, DaemonContext } from './daemon-context'
import { formatError, isDaemonStopError } from './daemon-utils'

const DIALOG_BOOTSTRAP_BATCH_SIZE = 200

export interface DialogPassResult {
  /** Marked peer IDs of every dialog the pass listed */
  visited: Set<number>
  /** The pass listed every dialog without an error */
  complete: boolean
  /** A daemon stop ended the pass early */
  stopped: boolean
}

function requireRuntime(ctx: DaemonContext, accountId: number): AccountRuntime {
  const rt = ctx.runtime.accounts.get(accountId)
  if (!rt) throw new Error(`Account ${accountId} has no cache open`)
  return rt
}

/**
 * One pass over an account's dialogs, archived ones included, into the
 * account's own cache. Every dialog
 * updates `chats_cache`, so the sync jobs can build an InputPeer for it. A
 * dialog also updates the chat's sync state (type, member count, policy and
 * the newest message ID), but the pass creates no state for an archived chat
 * without one. Such a chat starts syncing when a message arrives in it live,
 * which creates its state like in any other chat, or when `tg chats sync`
 * turns it on.
 *
 * Telegram lists joined communities apart from the dialogs, so the pass
 * caches them with one more request (#58). A community has no messages of
 * its own, so it gets no sync state. A failure of that request, a
 * FLOOD_WAIT included (it isn't waited out), is logged and leaves the pass
 * complete: it says nothing about the chats, and the next pass retries.
 *
 * A daemon stop ends the pass at the next dialog, so the shutdown doesn't
 * wait for the rest of the list (#56), and ends the page request the pass
 * is waiting on, a FLOOD_WAIT of up to five minutes included (#64).
 */
export async function syncAccountDialogs(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
): Promise<DialogPassResult> {
  const cacheDb = requireRuntime(ctx, accountId).db
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
  let stopped = false

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

    // chats_cache and chat_sync_state share the marked peer ID
    const chatId = Number(chatInput.chat_id)
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

  // The stop signal ends a page request at once, a FLOOD_WAIT it waits out
  // included (#64)
  const pages = client.withParams({
    abortSignal: ctx.runtime.shutdown.signal,
  })

  try {
    for await (const dialog of pages.iterDialogs({ archived: 'keep' })) {
      // Leaving the loop fetches no further page. The stop signal is a
      // macrotask, so it can't land between this check and the next page's
      // request: no page starts with the signal already aborted.
      if (ctx.state.shutdownRequested) {
        stopped = true
        break
      }
      onDialog(dialog)
    }
    complete = !stopped
  } catch (err) {
    if (ctx.state.shutdownRequested) {
      // A page that fails while the daemon stops is no fault of the account;
      // one the stop cut short is the stop itself, not worth a line
      stopped = true
      if (!isDaemonStopError(err)) {
        ctx.logger.debug(
          `[Account ${accountId}] Dialog page failed during the stop: ${formatError(err)}`,
        )
      }
    } else {
      ctx.logger.warn(
        `[Account ${accountId}] Failed to bootstrap dialogs after ${dialogsCount}: ${formatError(err)}`,
      )
    }
  }

  // Keep what the pass listed before an error, too.
  flushChats()
  flushUsers()

  let communitiesCount = 0
  if (!stopped && !ctx.state.shutdownRequested) {
    try {
      // The dialogs are saved and the next pass retries, so the request
      // never sleeps out a FLOOD_WAIT that would hold up the start of sync
      const rows = await fetchJoinedCommunities(
        client.withParams({
          abortSignal: ctx.runtime.shutdown.signal,
          floodSleepThreshold: 0,
        }),
      )
      if (rows.length > 0) chatsCache.upsertMany(rows)
      communitiesCount = rows.length
    } catch (err) {
      if (!ctx.state.shutdownRequested) {
        ctx.logger.warn(
          `[Account ${accountId}] Failed to list joined communities: ${formatError(err)}`,
        )
      } else if (!isDaemonStopError(err)) {
        ctx.logger.debug(
          `[Account ${accountId}] Communities request failed during the stop: ${formatError(err)}`,
        )
      }
    }
    // A stop during the request ends the pass like one during a page: it
    // marks nothing and refreshes no queues
    if (ctx.state.shutdownRequested) {
      stopped = true
      complete = false
    }
  }

  if (complete) {
    const elapsedMs = Date.now() - start
    ctx.logger.info(
      `[Account ${accountId}] Bootstrapped ${dialogsCount} dialogs (${archivedCount} archived), ${usersCount} users, ${communitiesCount} communities in ${Math.round(elapsedMs / 1000)}s`,
    )
  } else if (stopped) {
    ctx.logger.debug(
      `[Account ${accountId}] Dialog pass stopped after ${dialogsCount} dialogs: the daemon is stopping`,
    )
  }

  return { visited, complete, stopped }
}

/**
 * Enabled chats with a cursor in the account's cache that its pass didn't
 * list. After an incomplete pass their newest message is unknown, so each
 * gets one checking page.
 *
 * A complete pass lists every chat the account is in, and the account's
 * cache holds only its own chats, so the others were left, deleted or
 * migrated: with `markLeftCaughtUp` they are marked caught up. A chat turned
 * on with `tg chats sync` is the exception: it may be a public channel the
 * user never joined, which no dialog list shows and no live update reaches,
 * so it gets one checking page after every pass.
 */
export function markUnvisitedChats(
  chatSyncState: ChatSyncStateService,
  visited: Set<number>,
  passComplete: boolean,
  markLeftCaughtUp: boolean,
): number {
  const unvisited = chatSyncState
    .getEnabledWithCursor()
    .filter((chat) => !visited.has(chat.chat_id))

  if (!passComplete) {
    chatSyncState.markTopUnknown(unvisited.map((chat) => chat.chat_id))
    return unvisited.length
  }

  const optedIn = unvisited.filter((chat) => chat.sync_mode === 'on')
  chatSyncState.markTopUnknown(optedIn.map((chat) => chat.chat_id))
  if (markLeftCaughtUp) {
    chatSyncState.markCaughtUp(
      unvisited
        .filter((chat) => chat.sync_mode !== 'on')
        .map((chat) => chat.chat_id),
    )
  }
  return unvisited.length
}

/**
 * The startup dialog pass, one per connected account, each into its own
 * cache. It seeds `chats_cache` and `chat_sync_state` and tells the
 * scheduler which chats are behind. An account that didn't connect keeps
 * its sync state as it is, and one account's failed pass doesn't change
 * what another's complete pass marks. A daemon stop skips the accounts left,
 * and a pass it ended marks nothing: the chats it didn't reach keep their
 * sync state.
 */
export async function bootstrapDialogs(ctx: DaemonContext): Promise<void> {
  for (const [accountId, accountState] of ctx.state.accounts) {
    if (ctx.state.shutdownRequested) return
    const rt = ctx.runtime.accounts.get(accountId)
    if (!rt || accountState.status !== 'connected' || !accountState.client) {
      continue
    }

    try {
      const { visited, complete, stopped } = await syncAccountDialogs(
        ctx,
        accountId,
        accountState.client,
      )
      if (stopped) return
      const unvisited = markUnvisitedChats(
        createChatSyncStateService(rt.db),
        visited,
        complete,
        true,
      )
      if (unvisited > 0) {
        ctx.logger.debug(
          complete
            ? `[Account ${accountId}] ${unvisited} synced chat(s) are not in the dialog list`
            : `[Account ${accountId}] ${unvisited} synced chat(s) were not listed; checking each for new messages`,
        )
      }
    } catch (err) {
      ctx.logger.warn(
        `[Account ${accountId}] Failed to bootstrap dialogs: ${formatError(err)}`,
      )
    }
  }
}

/**
 * After a reconnect, list the account's dialogs on the new client, so the
 * scheduler catches up the chats that got messages while the connection was
 * down. Runs in the background, one pass per account at a time. A pass a
 * daemon stop ended marks nothing and refreshes no queues.
 */
export async function refreshDialogsAfterReconnect(
  ctx: DaemonContext,
  accountId: number,
  client: TelegramClient,
): Promise<void> {
  if (ctx.state.shutdownRequested) return
  if (ctx.runtime.dialogPassesInFlight.has(accountId)) return
  ctx.runtime.dialogPassesInFlight.add(accountId)

  try {
    const rt = requireRuntime(ctx, accountId)
    const { visited, complete, stopped } = await syncAccountDialogs(
      ctx,
      accountId,
      client,
    )
    if (stopped) return
    // The pass covers this account's own cache, so a complete one marks the
    // chats it didn't list caught up, as on start
    markUnvisitedChats(
      createChatSyncStateService(rt.db),
      visited,
      complete,
      true,
    )
    rt.scheduler?.refreshQueues()
  } catch (err) {
    const message = `[Account ${accountId}] Dialog pass after reconnect failed: ${formatError(err)}`
    if (ctx.state.shutdownRequested) ctx.logger.debug(message)
    else ctx.logger.warn(message)
  } finally {
    ctx.runtime.dialogPassesInFlight.delete(accountId)
  }
}
