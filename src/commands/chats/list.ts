import type { Database } from 'bun:sqlite'
import type { Dialog, TelegramClient, tl } from '@mtcute/bun'
import { type ArgsDef, defineCommand } from 'citty'
import { getResolvedCacheConfig } from '../../config'
import {
  chatSyncView,
  createChatSyncStateService,
} from '../../db/chat-sync-state'
import { type CachedChatInput, createChatsCache } from '../../db/chats-cache'
import { createGroupParticipation } from '../../db/group-participation'
import type { ChatType } from '../../db/types'
import { createUsersCache } from '../../db/users-cache'
import { getClientForAccount } from '../../services/telegram'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import {
  buildCachePaginatedResponse,
  paginate,
} from '../../utils/cache-pagination'
import { error, success, verbose } from '../../utils/output'
import { apiUserToCacheInput } from '../../utils/telegram-mappers'
import {
  reportConfigOrRateLimitError,
  wrapClientCallWithRateLimits,
} from '../../utils/telegram-rate-limits'
import { allowedChatIds } from '../access'
import { nextCommand } from '../next'
import {
  CHAT_TYPE_VALUES,
  chatRowToItem,
  dialogToCacheInput,
  fetchJoinedCommunities,
  filterChatsByType,
  isValidChatType,
} from './helpers'
import type { ChatsListOutput } from './list-output'

type DialogCollectorClient = Pick<TelegramClient, 'iterDialogs'>

async function collectDialogs(
  client: DialogCollectorClient,
): Promise<{ dialogs: Dialog[]; users: tl.RawUser[] }> {
  const dialogs: Dialog[] = []
  const users: tl.RawUser[] = []

  for await (const dialog of client.iterDialogs({ limit: 200 })) {
    dialogs.push(dialog)
    if (dialog.peer.type === 'user') {
      users.push(dialog.peer.raw)
    }
  }

  return { dialogs, users }
}

/**
 * Fetch the 200 newest unarchived dialogs and every joined community, which
 * Telegram lists apart from the dialogs (#58), and cache them with the
 * dialogs' users. A failed communities request leaves the dialogs listed.
 */
export async function fetchChatsFromApi(
  client: Pick<TelegramClient, 'iterDialogs' | 'withParams'>,
  cacheDb: Database,
): Promise<CachedChatInput[]> {
  const { dialogs, users } = await collectDialogs(client)

  let communities: CachedChatInput[] = []
  try {
    // Best effort: a FLOOD_WAIT fails it at once instead of holding up the list
    communities = await fetchJoinedCommunities(
      client.withParams({ floodSleepThreshold: 0 }),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    verbose(`Skipped joined communities: ${message}`)
  }

  const userInputs = users.map(apiUserToCacheInput)
  if (userInputs.length > 0) {
    createUsersCache(cacheDb).upsertMany(userInputs)
    verbose(`Cached ${userInputs.length} users from dialogs`)
  }

  const chatInputs = [...dialogs.map(dialogToCacheInput), ...communities]
  createChatsCache(cacheDb).upsertMany(chatInputs)
  verbose(
    `Cached ${dialogs.length} dialogs and ${communities.length} communities`,
  )
  return chatInputs
}

export const listChatsArgs = {
  limit: {
    type: 'string',
    description: 'Maximum number of chats to return (default: 50)',
    default: '50',
  },
  offset: {
    type: 'string',
    description: 'Offset for pagination (default: 0)',
    default: '0',
  },
  type: {
    type: 'string',
    description: `Filter by chat type: ${CHAT_TYPE_VALUES.join(', ')} (default: all)`,
  },
  unread: {
    type: 'boolean',
    description: 'Only chats with unread messages',
    default: false,
  },
  account: {
    type: 'string',
    description: ACCOUNT_SELECTOR_DESCRIPTION,
  },
  fresh: {
    type: 'boolean',
    description: 'Bypass cache and fetch from API',
    default: false,
  },
} satisfies ArgsDef

export const listChatsCommand = defineCommand({
  meta: {
    name: 'list',
    description: 'List chats and dialogs with pagination',
  },
  args: listChatsArgs,
  async run({ args }) {
    const limit = Number.parseInt(args.limit ?? '50', 10)
    const offset = Number.parseInt(args.offset ?? '0', 10)
    const fresh = args.fresh ?? false
    const unread = args.unread ?? false
    const rawType = args.type
    const typeFilter = rawType as ChatType | undefined

    if (rawType && !isValidChatType(rawType)) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid chat type: ${rawType}. Must be one of: ${CHAT_TYPE_VALUES.join(', ')}`,
      )
    }

    const { account, db: cacheDb } = openAccountCache(args.account)
    const allowed = await allowedChatIds(account.id)
    const isAllowed = (chat: { chat_id: string }) =>
      allowed === null || allowed.has(Number(chat.chat_id))

    try {
      const chatsCache = createChatsCache(cacheDb)
      const chatSyncState = createChatSyncStateService(cacheDb)
      const participation = createGroupParticipation(cacheDb)
      const toItem = (
        chat: Parameters<typeof chatRowToItem>[0],
      ): ChatsListOutput['items'][number] => {
        const item = chatRowToItem(chat)
        return {
          ...item,
          ...chatSyncView(participation, item.id, chatSyncState.get(item.id)),
        }
      }
      const cacheConfig = await getResolvedCacheConfig()

      if (!fresh) {
        // With allowedChats, every cached chat is a candidate (-1: no limit)
        const cachedChats = chatsCache
          .list({
            limit: allowed === null ? 1000 : -1,
            type: typeFilter,
            orderBy: 'last_message_at',
            unread,
          })
          .filter(isAllowed)

        // With --unread, a cache that knows unread counts answers even when
        // no chat has unread messages
        if (cachedChats.length > 0 || (unread && chatsCache.hasUnreadState())) {
          const response: ChatsListOutput = buildCachePaginatedResponse(
            cachedChats,
            toItem,
            {
              offset,
              limit,
              ttlMs: cacheConfig.staleness.dialogs,
              source: 'cache',
            },
          )

          success(response, nextChatsPage(args, response))
          return
        }
      }

      verbose('Fetching dialogs from Telegram API...')
      const client = wrapClientCallWithRateLimits(
        getClientForAccount(account.id),
        { context: 'cli:chats.list', accountId: account.id },
      )

      const chatInputs = await fetchChatsFromApi(client, cacheDb)

      const filteredChats = filterChatsByType(chatInputs, typeFilter).filter(
        (chat) => (!unread || (chat.unread_count ?? 0) > 0) && isAllowed(chat),
      )
      filteredChats.sort(
        (a, b) => (b.last_message_at ?? 0) - (a.last_message_at ?? 0),
      )

      const page = paginate(filteredChats, offset, limit)
      const response: ChatsListOutput = {
        ...page,
        items: page.items.map(toItem),
        source: 'api',
        stale: false,
      }

      success(response, nextChatsPage(args, response))
    } catch (err) {
      reportConfigOrRateLimitError(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      error(ErrorCodes.TELEGRAM_ERROR, `Failed to fetch chats: ${message}`)
    }
  },
})

function nextChatsPage(
  args: Record<string, unknown>,
  { hasMore, offset, limit }: ChatsListOutput,
) {
  if (!hasMore) return []
  return [
    nextCommand(
      'chats list',
      listChatsArgs,
      { ...args, limit, offset: offset + limit },
      'The next page of chats.',
    ),
  ]
}
