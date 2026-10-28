/**
 * tg media clean: remove files from the account's media cache. Bare, only
 * partial downloads nobody wrote to for a day go, so it is always safe;
 * complete files need --all, --older-than or --chat. Never writes cache.db
 * and opens no connection, unless an uncached --chat needs resolving.
 */
import { defineCommand } from 'citty'

import { getAccountMediaDir } from '../../db'
import { createMessageAttachmentsStore } from '../../db/message-attachments'
import { ErrorCodes } from '../../types'
import { openAccountCache } from '../../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../../utils/account-selector'
import {
  type CleanOptions,
  cleanMedia,
  PARTIAL_MAX_AGE_MS,
} from '../../utils/media-cache'
import { error, success } from '../../utils/output'
import { parseTimeBound } from '../../utils/time-bounds'
import {
  CHAT_ARG_DESCRIPTION,
  openHistory,
  reportHistoryError,
} from '../messages/helpers'
import { type HistoryChat, resolveHistoryChat } from '../messages/history'

/** --older-than as a ms epoch; INVALID_ARGS when it is none of the forms */
function parseOlderThan(
  value: string | undefined,
  now: number,
): number | undefined {
  if (value === undefined) return undefined
  const seconds = parseTimeBound(value, { now })
  if (seconds === null) {
    error(
      ErrorCodes.INVALID_ARGS,
      `Invalid --older-than: ${value}`,
      { older_than: value },
      'Use a duration back from now (30d, 12h, 2w), a date (2026-10-01) or a date and time (2026-10-01T09:30, local unless it ends with Z or an offset)',
    )
  }
  return seconds * 1000
}

export const cleanMediaCommand = defineCommand({
  meta: {
    name: 'clean',
    description:
      'Remove files from the media cache: partial downloads untouched for a day, and with --all, --older-than or --chat complete files too',
  },
  args: {
    'older-than': {
      type: 'string',
      description:
        'Remove files not used since then: 30d, 12h, 2026-10-01 or 2026-10-01T09:30',
    },
    chat: {
      type: 'string',
      description: `Remove the files of this chat's messages; a file another chat's message also holds stays. ${CHAT_ARG_DESCRIPTION}`,
    },
    all: {
      type: 'boolean',
      description: 'Remove every cached file',
      default: false,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const all = args.all ?? false
    const olderThanArg = args['older-than']
    if (all && (olderThanArg !== undefined || args.chat !== undefined)) {
      error(
        ErrorCodes.INVALID_ARGS,
        '--all removes every file: pass it without --older-than and --chat',
        { all, older_than: olderThanArg ?? null, chat: args.chat ?? null },
      )
    }
    const now = Date.now()
    const olderThan = parseOlderThan(olderThanArg, now)
    const { account, db } = openAccountCache(args.account)

    const options: CleanOptions = {
      all,
      olderThan,
      now,
      partialMaxAgeMs: PARTIAL_MAX_AGE_MS,
    }
    let chat: HistoryChat | undefined
    if (args.chat !== undefined) {
      try {
        const deps = openHistory(account.id, 'cli:media.clean')
        chat = await resolveHistoryChat(deps.client, args.chat, deps)
      } catch (err) {
        reportHistoryError(err, 'resolve --chat')
      }
      // Every cached file was downloaded with its message, which wrote the
      // message's attachment row
      const attachments = createMessageAttachmentsStore(db)
      const chatId = chat.chatId
      options.uniqueFileIds = new Set(attachments.uniqueFileIdsOfChat(chatId))
      options.isShared = (uniqueFileId) =>
        attachments.heldOutsideChat(uniqueFileId, chatId)
    }

    const mediaDir = getAccountMediaDir(account.id)
    let result: ReturnType<typeof cleanMedia>
    try {
      result = cleanMedia(mediaDir, options)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      error(
        ErrorCodes.GENERAL_ERROR,
        `Failed to clean the media cache: ${message}`,
        { path: mediaDir },
      )
    }

    success({
      accountId: account.id,
      ...result,
      filters: {
        all,
        /** The cutoff --older-than gave */
        olderThan:
          olderThan === undefined ? null : new Date(olderThan).toISOString(),
        /** The marked chat ID --chat resolved to */
        chat: chat?.chatId ?? null,
      },
    })
  },
})
