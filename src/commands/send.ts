import type { tl } from '@mtcute/tl'
import { defineCommand } from 'citty'

import { getCacheDb } from '../db'
import { createChatsCache } from '../db/chats-cache'
import { createUsersCache } from '../db/users-cache'
import { getClientForAccount } from '../services/telegram'
import { ErrorCodes } from '../types'
import {
  ACCOUNT_SELECTOR_DESCRIPTION,
  resolveAccountSelector,
} from '../utils/account-selector'
import { toLong } from '../utils/long'
import { error, success, verbose } from '../utils/output'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../utils/telegram-rate-limits'
import { resolvePeer } from './send/peer-resolver'

function extractMessageInfo(result: tl.TypeUpdates): {
  messageId: number | null
  timestamp: number | null
} {
  if (result._ === 'updateShortSentMessage') {
    return { messageId: result.id, timestamp: result.date }
  }

  if (!('updates' in result) || !result.updates) {
    return { messageId: null, timestamp: null }
  }

  for (const update of result.updates) {
    if (update._ === 'updateMessageID') {
      return {
        messageId: update.id ?? null,
        timestamp: null,
      }
    }
    if (
      update._ === 'updateNewMessage' ||
      update._ === 'updateNewChannelMessage'
    ) {
      const message = update.message
      if (
        message &&
        (message._ === 'message' || message._ === 'messageService')
      ) {
        return {
          messageId: message.id,
          timestamp: message.date,
        }
      }
    }
  }

  return { messageId: null, timestamp: null }
}

function handleSendError(recipient: string, message: string): never {
  if (message.includes('PEER_ID_INVALID')) {
    error(
      ErrorCodes.TELEGRAM_ERROR,
      `Invalid recipient: ${recipient}. Make sure the user/chat exists and you have access to it.`,
    )
  }
  if (message.includes('USER_IS_BOT')) {
    error(ErrorCodes.TELEGRAM_ERROR, 'Cannot send messages to bots this way.')
  }
  if (message.includes('CHAT_WRITE_FORBIDDEN')) {
    error(
      ErrorCodes.TELEGRAM_ERROR,
      'You do not have permission to send messages in this chat.',
    )
  }

  error(ErrorCodes.TELEGRAM_ERROR, `Failed to send message: ${message}`)
}

/**
 * Send message command
 */
export const sendCommand = defineCommand({
  meta: {
    name: 'send',
    description: 'Send a message to a user, group, or channel',
  },
  args: {
    to: {
      type: 'string',
      description: 'Recipient: user ID, @username, or phone number',
      required: true,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Message text to send',
      required: true,
    },
    account: {
      type: 'string',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
    silent: {
      type: 'boolean',
      description: 'Send without notification sound',
      default: false,
    },
    'reply-to': {
      type: 'string',
      description: 'Message ID to reply to',
    },
  },
  async run({ args }) {
    const recipient = args.to
    const messageText = args.message
    const accountId = resolveAccountSelector(args.account)
    const silent = args.silent
    const replyTo = args['reply-to']
      ? Number.parseInt(args['reply-to'], 10)
      : undefined

    if (!messageText || messageText.trim() === '') {
      error(ErrorCodes.INVALID_ARGS, 'Message text cannot be empty')
    }

    try {
      const cacheDb = getCacheDb()
      const usersCache = createUsersCache(cacheDb)
      const chatsCache = createChatsCache(cacheDb)

      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:send' },
      )

      verbose(`Resolving recipient: ${recipient}`)
      const { inputPeer, name } = await resolvePeer(
        client,
        recipient,
        usersCache,
        chatsCache,
      )

      verbose(`Sending message to ${name}...`)

      const request: tl.messages.RawSendMessageRequest = {
        _: 'messages.sendMessage',
        peer: inputPeer,
        message: messageText,
        randomId: toLong(
          BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
        ),
        noWebpage: false,
        silent,
      }

      if (replyTo) {
        request.replyTo = {
          _: 'inputReplyToMessage',
          replyToMsgId: replyTo,
        }
      }

      const result = await client.call(request)
      const { messageId, timestamp } = extractMessageInfo(result)

      success({
        sent: true,
        to: {
          identifier: recipient,
          name,
        },
        messageId,
        timestamp: timestamp ? timestamp * 1000 : Date.now(),
        replyTo: replyTo ?? null,
        silent,
      })
    } catch (err) {
      if (isRateLimitError(err)) {
        error(
          ErrorCodes.RATE_LIMITED,
          `Rate limited for ${err.method}. Wait ${err.waitSeconds}s before retrying.`,
          { method: err.method, wait_seconds: err.waitSeconds },
        )
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      handleSendError(recipient, message)
    }
  },
})
