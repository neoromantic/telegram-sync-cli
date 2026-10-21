import { defineCommand } from 'citty'

import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import { success } from '../../utils/output'
import {
  CHAT_ARG_DESCRIPTION,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from './helpers'
import { getMessageWithContext, resolveHistoryChat } from './history'

/** 2 * 49 + 1 = 99 messages: one getHistory page holds the whole window */
const MAX_CONTEXT = 49

export const getMessageCommand = defineCommand({
  meta: {
    name: 'get',
    description:
      'Get one message of a chat, with --context messages on each side (newer and older, newest first; cache-first)',
  },
  args: {
    chat: {
      type: 'string',
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    id: {
      type: 'string',
      description: 'Message ID',
      required: true,
    },
    context: {
      type: 'string',
      description: `Messages to include on each side, 0-${MAX_CONTEXT}`,
      default: '0',
    },
    includeDeleted: {
      type: 'boolean',
      description: 'Include deleted messages in the context',
      default: false,
    },
    fresh: {
      type: 'boolean',
      description:
        'Fetch the message and its context from Telegram and cache them',
      default: false,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const messageId = parseIntegerArg(args.id, 'id', { min: 1 })
    const context = parseIntegerArg(args.context, 'context', {
      min: 0,
      max: MAX_CONTEXT,
      default: 0,
    })
    const accountId = resolveAccountSelector(args.account)

    try {
      const deps = openHistory(accountId, 'cli:messages.get')
      const chat = await resolveHistoryChat(deps.client, args.chat, deps)
      const result = await getMessageWithContext({
        cacheDb: deps.cacheDb,
        client: deps.client,
        chat,
        messageId,
        context,
        includeDeleted: args.includeDeleted ?? false,
        fresh: args.fresh ?? false,
      })
      success(result)
    } catch (err) {
      reportHistoryError(err, 'get message')
    }
  },
})
