import { accessSync, constants, statSync } from 'node:fs'
import { basename } from 'node:path'
import { tl } from '@mtcute/bun'
import { defineCommand } from 'citty'

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
  reportConfigOrRateLimitError,
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

const richErrorHints: Record<string, string> = {
  RICH_MESSAGE_UNSUPPORTED:
    'Rich sending is unavailable for this account or chat. Omit the formatting flag to send plain text.',
  RICH_MESSAGE_EMPTY: 'Add visible content to the rich message.',
  RICH_MESSAGE_TEXT_TOO_LONG:
    'Shorten the rich message text to 32768 characters or fewer.',
  RICH_MESSAGE_BLOCKS_TOO_MANY: 'Use at most 500 blocks.',
  RICH_MESSAGE_MEDIA_TOO_MANY: 'Use at most 50 media attachments.',
  RICH_MESSAGE_TABLE_COLS_TOO_MANY: 'Use at most 20 table columns.',
}

function handleSendError(
  recipient: string,
  err: unknown,
  rich: boolean,
): never {
  if (rich && tl.RpcError.is(err) && err.text.startsWith('RICH_MESSAGE_')) {
    error(
      ErrorCodes.TELEGRAM_ERROR,
      err.message,
      { telegramError: err.text },
      richErrorHints[err.text],
    )
  }
  const message = err instanceof Error ? err.message : 'Unknown error'

  if (message.includes('PEER_ID_INVALID')) {
    error(
      ErrorCodes.TELEGRAM_ERROR,
      `Invalid recipient: ${recipient}. Make sure the user/chat exists and you have access to it.`,
      undefined,
      // A user ID the cache has no access hash for
      /^\d+$/.test(recipient.trim())
        ? "Send to the user's @username or +phone once: tg caches the user, and its ID works after that"
        : undefined,
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

/** How Telegram reads --message: as a rich message it parses itself */
type RichFormat = 'markdown' | 'html'

function richMessage(
  text: string,
  format: RichFormat,
): tl.TypeInputRichMessage {
  return format === 'markdown'
    ? { _: 'inputRichMessageMarkdown', markdown: text }
    : { _: 'inputRichMessageHTML', html: text }
}

function sendMessageRequest(
  peer: tl.TypeInputPeer,
  text: string,
  silent: boolean,
  replyTo: number | undefined,
  format: RichFormat | null,
): tl.messages.RawSendMessageRequest {
  const request: tl.messages.RawSendMessageRequest = {
    _: 'messages.sendMessage',
    peer,
    // A rich message carries its content in richMessage and has no text
    message: format ? '' : text,
    randomId: toLong(
      BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
    ),
    noWebpage: false,
    silent,
  }

  if (format) request.richMessage = richMessage(text, format)

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
  | { file: null; text: string; format: RichFormat | null }
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
    markdown?: boolean
    html?: boolean
  },
  rawArgs: string[],
): SendContent {
  if (args.markdown && args.html) {
    error(ErrorCodes.INVALID_ARGS, 'Use --markdown or --html, not both')
  }
  const format = args.markdown ? 'markdown' : args.html ? 'html' : null

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
    return { file: null, text: args.message, format }
  }

  if (format) {
    error(
      ErrorCodes.INVALID_ARGS,
      `--${format} formats --message: a caption is plain text`,
    )
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
    markdown: {
      type: 'boolean',
      default: false,
      description:
        'Send --message as a rich message written in Markdown: headings, tables, lists, quotes, code, formulas',
    },
    html: {
      type: 'boolean',
      default: false,
      description: 'Send --message as a rich message written in HTML',
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
  setup(ctx) {
    // A chat allowlist can resolve the recipient before run().
    if (ctx.args.markdown || ctx.args.html) {
      ctx.data = readSendContent(ctx.args, ctx.rawArgs)
    }
  },
  async run({ args, rawArgs, data }) {
    const recipient = args.to
    const silent = args.silent
    const replyTo = args['reply-to']
      ? Number.parseInt(args['reply-to'], 10)
      : undefined

    const content: SendContent = data ?? readSendContent(args, rawArgs ?? [])

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
          sendMessageRequest(
            inputPeer,
            content.text,
            silent,
            replyTo,
            content.format,
          ),
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
        format: content.file === null ? content.format : null,
        ...fileOutput,
      })
    } catch (err) {
      if (err instanceof AmbiguousPeerError) {
        error(ErrorCodes.INVALID_ARGS, err.message, {
          to: err.identifier,
          candidates: err.candidates,
        })
      }
      reportConfigOrRateLimitError(err)
      handleSendError(
        recipient,
        err,
        content.file === null && content.format !== null,
      )
    }
  },
})
