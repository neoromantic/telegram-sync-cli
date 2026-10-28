import { accessSync, constants, statSync } from 'node:fs'
import { basename } from 'node:path'
import type { tl } from '@mtcute/bun'
import { defineCommand } from 'citty'

import { ConfigError } from '../config'
import { accountsDb } from '../db'
import { createChatsCache } from '../db/chats-cache'
import { createUsersCache } from '../db/users-cache'
import { getClientForAccount } from '../services/telegram'
import { ErrorCodes } from '../types'
import { openAccountCache } from '../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../utils/account-selector'
import { flagValues } from '../utils/args'
import { toLong } from '../utils/long'
import { error, success, verbose } from '../utils/output'
import { createProgress } from '../utils/progress'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../utils/telegram-rate-limits'
import {
  AmbiguousPeerError,
  createDmLookup,
  resolvePeer,
} from './send/peer-resolver'
import { sendFile, sentAttachment } from './send/send-file'
import { cacheSentMessage, resolveSelfId } from './send/sent-message-cache'

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

function sendMessageRequest(
  peer: tl.TypeInputPeer,
  text: string,
  silent: boolean,
  replyTo: number | undefined,
): tl.messages.RawSendMessageRequest {
  const request: tl.messages.RawSendMessageRequest = {
    _: 'messages.sendMessage',
    peer,
    message: text,
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
  return request
}

/** What to send: text, or one file with an optional caption */
type SendContent =
  | { file: null; text: string }
  | { file: string; caption: string; forceDocument: boolean }

/** Exits with INVALID_ARGS unless path names a readable, non-empty regular file */
function checkSendableFile(path: string): void {
  let size: number
  try {
    const stats = statSync(path)
    if (!stats.isFile()) throw new Error('not a regular file')
    accessSync(path, constants.R_OK)
    size = stats.size
  } catch {
    error(ErrorCodes.INVALID_ARGS, `Not a readable file: ${path}`, {
      file: path,
    })
  }
  if (size === 0) {
    error(ErrorCodes.INVALID_ARGS, `File is empty: ${path}`, { file: path })
  }
}

/** Checks that need no account and no network, run before either opens */
function readSendContent(
  args: {
    message?: string
    file?: string
    caption?: string
    'force-document'?: boolean
  },
  rawArgs: string[],
): SendContent {
  const files = flagValues(rawArgs, 'file')
  if (files.length > 1) {
    error(
      ErrorCodes.INVALID_ARGS,
      "Send one file per message: albums aren't supported yet",
      { files },
    )
  }

  const file = args.file
  if (file === undefined) {
    if (args.message === undefined) {
      error(ErrorCodes.INVALID_ARGS, 'Pass --message <text> or --file <path>')
    }
    if (args.caption !== undefined) {
      error(ErrorCodes.INVALID_ARGS, '--caption needs --file')
    }
    if (args['force-document']) {
      error(ErrorCodes.INVALID_ARGS, '--force-document needs --file')
    }
    if (args.message.trim() === '') {
      error(ErrorCodes.INVALID_ARGS, 'Message text cannot be empty')
    }
    return { file: null, text: args.message }
  }

  if (args.message !== undefined) {
    error(
      ErrorCodes.INVALID_ARGS,
      'Use --caption for the text sent with --file',
    )
  }
  checkSendableFile(file)
  return {
    file,
    caption: args.caption ?? '',
    forceDocument: args['force-document'] ?? false,
  }
}

/**
 * Send message command
 */
export const sendCommand = defineCommand({
  meta: {
    name: 'send',
    description: 'Send a message or a file to a user, group, or channel',
  },
  args: {
    to: {
      type: 'string',
      description:
        'Recipient: @username, user or chat ID (as tg chats list or tg messages search print it), phone number (+…), or me (Saved Messages)',
      required: true,
    },
    message: {
      type: 'string',
      alias: 'm',
      description: 'Message text (or use --file)',
    },
    file: {
      type: 'string',
      description:
        'Send this file: a photo for JPEG/PNG/WebP images up to 10 MB, otherwise a document. One per message',
    },
    caption: {
      type: 'string',
      description: 'Text sent with --file',
    },
    'force-document': {
      type: 'boolean',
      default: false,
      description: 'Send an image as a file (document), not as a photo',
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
  async run({ args, rawArgs }) {
    const recipient = args.to
    const silent = args.silent
    const replyTo = args['reply-to']
      ? Number.parseInt(args['reply-to'], 10)
      : undefined

    // Tests call run() with args only
    const content = readSendContent(args, rawArgs ?? [])

    // The recipient resolves with this account's access hashes
    const { account, db: cacheDb } = openAccountCache(args.account)
    const accountId = account.id

    try {
      const usersCache = createUsersCache(cacheDb)
      const chatsCache = createChatsCache(cacheDb)

      const client = wrapClientCallWithRateLimits(
        getClientForAccount(accountId),
        { context: 'cli:send', accountId },
      )

      verbose(`Resolving recipient: ${recipient}`)
      const { inputPeer, name } = await resolvePeer(
        client,
        recipient,
        usersCache,
        chatsCache,
        createDmLookup(cacheDb),
      )

      const text = content.file === null ? content.text : content.caption
      let result: tl.TypeUpdates
      let fileOutput = {}
      if (content.file === null) {
        verbose(`Sending message to ${name}...`)
        result = await client.call(
          sendMessageRequest(inputPeer, content.text, silent, replyTo),
        )
      } else {
        const fileName = basename(content.file)
        verbose(`Sending ${fileName} to ${name}...`)
        const sent = await sendFile(client, {
          peer: inputPeer,
          path: content.file,
          caption: content.caption,
          silent,
          replyTo,
          forceDocument: content.forceDocument,
          progress: createProgress(fileName),
        })
        result = sent.result
        fileOutput = {
          file: {
            name: sent.fileName,
            mimeType: sent.mimeType,
            size: sent.size,
            sentAs: sent.kind,
          },
          attachment: sentAttachment(result),
        }
      }
      const { messageId, timestamp } = extractMessageInfo(result)

      await cacheSentMessage(
        {
          cacheDb,
          getSelfId: () => resolveSelfId(client, accountId, accountsDb),
        },
        result,
        { peer: inputPeer, text, replyTo },
      )

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
        ...fileOutput,
      })
    } catch (err) {
      if (err instanceof AmbiguousPeerError) {
        error(ErrorCodes.INVALID_ARGS, err.message, {
          to: err.identifier,
          candidates: err.candidates,
        })
      }
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
      }
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
