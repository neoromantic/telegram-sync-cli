import { defineCommand } from 'citty'

import { ErrorCodes } from '../../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../../utils/account-selector'
import { error, success } from '../../utils/output'
import {
  CHAT_ARG_DESCRIPTION,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from './helpers'
import { listHistory, resolveHistoryChat } from './history'

export const listMessagesCommand = defineCommand({
  meta: {
    name: 'list',
    description:
      'List the messages of a chat, newest first (cache-first). Page back with --before <nextBefore> and forward with --after <nextAfter> until items is empty',
  },
  args: {
    chat: {
      type: 'string',
      description: CHAT_ARG_DESCRIPTION,
      required: true,
    },
    limit: {
      type: 'string',
      description: 'Messages per page, 1-100',
      default: '20',
    },
    before: {
      type: 'string',
      description:
        'Only messages older than this message ID (pass nextBefore to page back)',
    },
    after: {
      type: 'string',
      description:
        'The messages right after this message ID (pass nextAfter to page forward; 0 starts at the first message)',
    },
    includeDeleted: {
      type: 'boolean',
      description: 'Include deleted messages',
      default: false,
    },
    fresh: {
      type: 'boolean',
      description: 'Fetch the page from Telegram and cache it',
      default: false,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const limit = parseIntegerArg(args.limit, 'limit', {
      min: 1,
      max: 100,
      default: 20,
    })
    const before = parseIntegerArg(args.before, 'before', { min: 1 })
    const after = parseIntegerArg(args.after, 'after', { min: 0 })
    if (before !== undefined && after !== undefined && after >= before) {
      error(
        ErrorCodes.INVALID_ARGS,
        `--after (${after}) must be smaller than --before (${before})`,
        { after, before },
      )
    }
    const accountId = resolveAccountSelector(args.account)

    try {
      const deps = openHistory(accountId, 'cli:messages.list')
      const chat = await resolveHistoryChat(deps.client, args.chat, deps)
      const result = await listHistory({
        cacheDb: deps.cacheDb,
        client: deps.client,
        chat,
        window: { limit, before, after },
        includeDeleted: args.includeDeleted ?? false,
        fresh: args.fresh ?? false,
      })
      success(result)
    } catch (err) {
      reportHistoryError(err, 'list messages')
    }
  },
})
