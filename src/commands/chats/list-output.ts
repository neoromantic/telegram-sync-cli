// The CLI imports only types from this file, so zod (a devDependency) never ships
import { z } from 'zod'
import type { SyncReason } from '../../db/chat-sync-state'
import { CHAT_TYPE_VALUES } from './helpers'

const SYNC_REASONS = [
  'dm',
  'bot',
  'deleted_account',
  'small_group',
  'medium_group',
  'large_group',
  'unknown_size',
  'channel',
  'community',
  'on_by_hand',
  'off_by_hand',
] as const satisfies readonly SyncReason[]

export const chatItem = z.strictObject({
  id: z
    .int()
    .describe(
      'Marked peer ID: the user ID, `-N` for a basic group, `-100…` for a supergroup, channel or community',
    ),
  type: z.enum(CHAT_TYPE_VALUES).describe('Chat type'),
  title: z
    .string()
    .describe("Chat title or the user's name; empty when Telegram gave none"),
  username: z.string().nullable().describe('Public username, without `@`'),
  memberCount: z
    .int()
    .nullable()
    .describe('Members of a group or channel; `null` when unknown'),
  lastMessageAt: z
    .int()
    .nullable()
    .describe('Time of the newest message, Unix milliseconds'),
  isCreator: z.boolean().describe('The account created the chat'),
  isAdmin: z.boolean().describe('The account is an admin of the chat'),
  unreadCount: z
    .int()
    .nullable()
    .describe(
      'Unread incoming messages as Telegram counts them; `null` before a dialog list has the chat (a daemon start or `--fresh`)',
    ),
})

export const chatsListOutput = z.strictObject({
  items: z
    .array(
      chatItem.extend({
        syncEnabled: z
          .boolean()
          .describe("Whether the daemon syncs the chat's messages"),
        syncReason: z
          .enum(SYNC_REASONS)
          .nullable()
          .describe(
            "Why: the policy's reason (`medium_group` is the default; `large_group`, `unknown_size`, `channel` and `community` are off), or `on_by_hand` / `off_by_hand` from `tg chats sync`; `null` for a chat without sync state: an archived chat that hasn't synced yet, or one no daemon start has seen",
          ),
      }),
    )
    .describe('The page of chats, newest message first'),
  total: z.int().describe('Chats that match the filters'),
  offset: z.int().describe('`--offset`'),
  limit: z.int().describe('`--limit`'),
  hasMore: z.boolean().describe('More chats follow this page'),
  source: z
    .enum(['cache', 'api'])
    .describe(
      '`cache`, or `api` with `--fresh` or when the cache has no matching chat',
    ),
  stale: z
    .boolean()
    .describe(
      'A matching cached chat is older than `cache.staleness.dialogs`; always `false` from the API',
    ),
})

export type ChatItem = z.infer<typeof chatItem>
export type ChatsListOutput = z.infer<typeof chatsListOutput>
