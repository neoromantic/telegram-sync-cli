import { defineCommand } from 'citty'

import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { error, success } from '../../utils/output'
import {
  parseTimeWindow,
  parseTypeArg,
  SINCE_ARG_DESCRIPTION,
  TYPE_ARG_DESCRIPTION,
  UNTIL_ARG_DESCRIPTION,
} from './filters'
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
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
    type: {
      type: 'string',
      description: `${TYPE_ARG_DESCRIPTION}. With --type, --since or --until the page comes from the cache only, with complete saying whether the cache holds all of it`,
    },
    since: { type: 'string', description: SINCE_ARG_DESCRIPTION },
    until: { type: 'string', description: UNTIL_ARG_DESCRIPTION },
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
  async run({ args, rawArgs }) {
    const limit = parseIntegerArg(args.limit, 'limit', {
      min: 1,
      max: 100,
      default: 20,
    })
    const before = parseIntegerArg(args.before, 'before', {
      min: 1,
      max: MAX_MESSAGE_ID,
    })
    const after = parseIntegerArg(args.after, 'after', {
      min: 0,
      max: MAX_MESSAGE_ID - 1,
    })
    if (before !== undefined && after !== undefined && after >= before) {
      error(
        ErrorCodes.INVALID_ARGS,
        `--after (${after}) must be smaller than --before (${before})`,
        { after, before },
      )
    }
    const types = parseTypeArg(rawArgs ?? [])
    const { since, until } = parseTimeWindow(args)
    const filtered =
      types !== undefined || since !== undefined || until !== undefined
    if (filtered && args.fresh) {
      error(
        ErrorCodes.INVALID_ARGS,
        '--fresh reads an unfiltered page from Telegram; --type, --since and --until read the cache',
        undefined,
        'Fetch pages with tg messages list --fresh (no filters), then filter',
      )
    }
    const { account } = openAccountCache(args.account)

    try {
      const deps = openHistory(account.id, 'cli:messages.list')
      const chat = await resolveHistoryChat(deps.client, args.chat, deps)
      const result = await listHistory({
        cacheDb: deps.cacheDb,
        client: deps.client,
        chat,
        window: { limit, before, after },
        includeDeleted: args.includeDeleted ?? false,
        fresh: args.fresh ?? false,
        filter: filtered ? { types, since, until } : undefined,
      })
      success(result)
    } catch (err) {
      reportHistoryError(err, 'list messages')
    }
  },
})
