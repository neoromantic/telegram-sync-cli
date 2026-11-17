import type { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { defineCommand } from 'citty'

import { createPidFile } from '../../daemon'
import { getDataDir } from '../../db'
import { createDaemonStatusService } from '../../db/daemon-status'
import { createNewMessagesFeed, oldestFirst } from '../../db/new-messages'
import { exitAfterFlush, isExiting } from '../../telemetry'
import { type Account, ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import { error, success, verbose } from '../../utils/output'
import { allowedChatIds } from '../access'
import {
  CHAT_ARG_DESCRIPTION,
  MAX_MESSAGE_ID,
  messageItemReader,
  openHistory,
  parseIntegerArg,
  reportHistoryError,
} from './helpers'
import { resolveHistoryChat } from './history'

/** How often the cache is checked for new messages */
const POLL_MS = 200

/**
 * Fail unless the daemon runs for the account: only it stores new messages,
 * so without it nothing would ever arrive. It runs when daemon.pid names a
 * live process and the account's daemon rows are that process's.
 */
function requireDaemon(account: Account, cacheDb: Database): void {
  const pid = createPidFile(join(getDataDir(), 'daemon.pid')).read()
  const daemon = createDaemonStatusService(cacheDb).getDaemonInfo()
  if (pid !== null && daemon.status === 'running' && daemon.pid === pid) {
    return
  }
  error(
    ErrorCodes.DAEMON_NOT_RUNNING,
    `The daemon is not running for account ${account.id}, so no new messages would arrive`,
    { account_id: account.id },
    'Start it with tg daemon start, then retry',
  )
}

/**
 * The account's cache, the daemon check and `--chat` resolved: what wait and
 * watch read
 */
async function openFeed(
  args: { account?: string; chat?: string; after?: string },
  context: string,
) {
  const after = parseIntegerArg(args.after, 'after', {
    min: 0,
    max: MAX_MESSAGE_ID,
  })
  if (after !== undefined && args.chat === undefined) {
    error(
      ErrorCodes.INVALID_ARGS,
      '--after needs --chat: message IDs are per chat',
      { after },
    )
  }
  const { account, db } = openAccountCache(args.account)
  requireDaemon(account, db)

  let chatId: number | undefined
  if (args.chat !== undefined) {
    try {
      const deps = openHistory(account.id, context)
      chatId = (await resolveHistoryChat(deps.client, args.chat, deps)).chatId
    } catch (err) {
      reportHistoryError(err, 'resolve the chat')
    }
  }
  // Without --chat, every chat's messages: keep to allowedChats
  const allowed = chatId === undefined ? await allowedChatIds(account.id) : null
  const feed = createNewMessagesFeed(db, {
    chatId,
    after,
    chatIds: allowed === null ? undefined : [...allowed],
  })
  verbose(`Waiting for messages${chatId === undefined ? '' : ` in ${chatId}`}`)
  return { feed, toItem: messageItemReader(db) }
}

const accountArg = {
  type: 'string',
  description: ACCOUNT_SELECTOR_DESCRIPTION,
} as const

export const waitMessagesCommand = defineCommand({
  meta: {
    name: 'wait',
    description:
      'Wait until the daemon stores a new message, then print the new messages oldest first (reads only the cache; needs a running daemon)',
  },
  args: {
    chat: {
      type: 'string',
      description: `Only this chat. ${CHAT_ARG_DESCRIPTION}`,
    },
    after: {
      type: 'string',
      description:
        "Return the chat's messages newer than this ID, cached ones at once (needs --chat); default: only messages stored after the command starts",
    },
    timeout: {
      type: 'string',
      description:
        'Seconds to wait; then messages is [] and timedOut is true (exit 0)',
      default: '60',
    },
    settle: {
      type: 'string',
      description:
        'After the first new message, keep collecting until this many seconds pass without another',
      default: '0',
    },
    account: accountArg,
  },
  async run({ args }) {
    const timeout = parseIntegerArg(args.timeout, 'timeout', {
      min: 0,
      default: 60,
    })
    const settle = parseIntegerArg(args.settle, 'settle', {
      min: 0,
      default: 0,
    })
    const deadline = Date.now() + timeout * 1000
    const { feed, toItem } = await openFeed(args, 'cli:messages.wait')

    const rows = [...feed.initial]
    let lastNewAt = Date.now()
    for (;;) {
      const now = Date.now()
      if (rows.length > 0 && now - lastNewAt >= settle * 1000) break
      if (now >= deadline) break
      await Bun.sleep(Math.min(POLL_MS, deadline - now))
      const batch = feed.poll()
      if (batch.length > 0) {
        rows.push(...batch)
        lastNewAt = Date.now()
      }
    }

    const messages = rows.sort(oldestFirst).map(toItem)
    success({ messages, timedOut: messages.length === 0 })
  },
})

export const watchMessagesCommand = defineCommand({
  meta: {
    name: 'watch',
    description:
      'Print each message the daemon stores as one JSON line (NDJSON), oldest first, until SIGINT or SIGTERM (reads only the cache; needs a running daemon)',
  },
  args: {
    chat: {
      type: 'string',
      description: `Only this chat. ${CHAT_ARG_DESCRIPTION}`,
    },
    account: accountArg,
  },
  async run({ args }) {
    const { feed, toItem } = await openFeed(args, 'cli:messages.watch')

    const stop = () => void exitAfterFlush(0)
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    while (!isExiting()) {
      for (const row of feed.poll()) {
        console.log(JSON.stringify(toItem(row)))
      }
      await Bun.sleep(POLL_MS)
    }
  },
})
