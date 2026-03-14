import type { Dialog, TelegramClient } from '@mtcute/bun'
import type { tl } from '@mtcute/tl'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { getCacheDb } from '../db'
import { createChatSyncStateService } from '../db/chat-sync-state'
import { createChatsCache } from '../db/chats-cache'
import { determineSyncPolicy, type SyncChatType } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { apiUserToCacheInput } from '../utils/telegram-mappers'
import { toPeerIdFromRawPeer } from '../utils/telegram-peer-ids'
import type { DaemonContext } from './daemon-context'
import { formatError } from './daemon-utils'

const DIALOG_BOOTSTRAP_BATCH_SIZE = 200

async function iterateDialogs(
  client: TelegramClient,
  onDialog: (dialog: Dialog) => void,
): Promise<number> {
  let count = 0
  for await (const dialog of client.iterDialogs()) {
    onDialog(dialog)
    count++
  }
  return count
}

export async function bootstrapDialogs(ctx: DaemonContext): Promise<void> {
  const cacheDb = getCacheDb()
  const chatsCache = createChatsCache(cacheDb)
  const usersCache = createUsersCache(cacheDb)
  const chatSyncState = createChatSyncStateService(cacheDb)

  for (const [accountId, accountState] of ctx.state.accounts) {
    if (accountState.status !== 'connected' || !accountState.client) {
      continue
    }

    ctx.logger.info(`[Account ${accountId}] Bootstrapping dialogs...`)
    const start = Date.now()

    const chatsBatch = [] as ReturnType<typeof dialogToCacheInput>[]
    const usersBatch = [] as ReturnType<typeof apiUserToCacheInput>[]
    let dialogsCount = 0
    let usersCount = 0

    try {
      dialogsCount = await iterateDialogs(accountState.client, (dialog) => {
        const chatInput = dialogToCacheInput(dialog)
        chatsBatch.push(chatInput)

        if (dialog.peer.type === 'user' && dialog.peer.raw) {
          usersBatch.push(apiUserToCacheInput(dialog.peer.raw as tl.RawUser))
        }

        const rawPeer = dialog.raw?.peer as
          | { _?: string; userId?: number; chatId?: number; channelId?: number }
          | undefined
        const peerId = toPeerIdFromRawPeer(rawPeer ?? null)
        const chatId = peerId ?? Number(chatInput.chat_id)
        const syncType = chatInput.type as SyncChatType
        const policy = determineSyncPolicy(
          syncType,
          chatInput.member_count ?? undefined,
        )

        chatSyncState.upsert({
          chat_id: chatId,
          chat_type: syncType,
          member_count: chatInput.member_count ?? undefined,
          sync_priority: policy.priority,
          sync_enabled: policy.enabled,
        })

        if (chatsBatch.length >= DIALOG_BOOTSTRAP_BATCH_SIZE) {
          chatsCache.upsertMany(chatsBatch.splice(0, chatsBatch.length))
        }

        if (usersBatch.length >= DIALOG_BOOTSTRAP_BATCH_SIZE) {
          const batch = usersBatch.splice(0, usersBatch.length)
          usersCache.upsertMany(batch)
          usersCount += batch.length
        }
      })

      if (chatsBatch.length > 0) {
        chatsCache.upsertMany(chatsBatch)
      }
      if (usersBatch.length > 0) {
        usersCache.upsertMany(usersBatch)
        usersCount += usersBatch.length
      }

      const elapsedMs = Date.now() - start
      ctx.logger.info(
        `[Account ${accountId}] Bootstrapped ${dialogsCount} dialogs, ${usersCount} users in ${Math.round(elapsedMs / 1000)}s`,
      )
    } catch (err) {
      ctx.logger.warn(
        `[Account ${accountId}] Failed to bootstrap dialogs: ${formatError(err)}`,
      )
    }
  }
}
