/**
 * Several messages of one chat in one `tg media download` run: one client,
 * one peer resolution, the messages fetched together, and a flood wait that
 * pauses the whole batch instead of failing a file
 */
import type { TelegramClient, tl } from '@mtcute/bun'

import { createMessagesCache } from '../../db/messages-cache'
import { ErrorCodes } from '../../types'
import { extractAttachment } from '../../utils/attachment'
import { info } from '../../utils/output'
import { isRateLimitError } from '../../utils/telegram-rate-limits'
import { type HistoryChat, resolveHistoryChat } from '../messages/history'
import {
  type DownloadDeps,
  type DownloadResult,
  downloadMedia,
  readFromCache,
} from './download-media'
import { DownloadInterruptedError, MediaError } from './errors'
import { cacheFetchedMessage, type FetchedRawMessage } from './fetch'

/**
 * Telegram's soft limits for files downloaded in parallel from one DC
 * (small_queue_max_active_operations_count and
 * large_queue_max_active_operations_count, https://core.telegram.org/api/config)
 */
export const MAX_PARALLEL_FILES = 5
export const MAX_PARALLEL_LARGE_FILES = 2
export const LARGE_FILE_BYTES = 20 * 1024 * 1024
/** Message IDs per getMessages call, as Telegram's own clients send them */
const IDS_PER_FETCH = 100
/** Longer flood waits fail the files instead of pausing the batch */
export const MAX_BATCH_FLOOD_WAIT_SECONDS = 300
/** Flood waits one file sits out before it fails */
const MAX_WAITS_PER_FILE = 5

export interface BatchRequest {
  chat: string
  messageIds: number[]
  thumb: boolean
  fresh: boolean
}

export interface FileFailure {
  code: (typeof ErrorCodes)[keyof typeof ErrorCodes]
  message: string
  details: Record<string, unknown>
  suggestion?: string
}

/** What the command does with each file as it finishes */
export interface BatchHandlers {
  /** Copy or print a downloaded file; throws a MediaError to fail it */
  done: (result: DownloadResult) => Promise<void>
  failed: (messageId: number, failure: FileFailure) => void
}

type MessagesResponse = Extract<
  tl.RpcCallReturn['messages.getMessages'],
  { messages: unknown }
>

function rateLimitWait(
  err: unknown,
): { method: string; seconds: number } | null {
  if (isRateLimitError(err)) {
    return { method: err.method, seconds: err.waitSeconds }
  }
  if (err instanceof MediaError && err.code === ErrorCodes.RATE_LIMITED) {
    return {
      method: String(err.details.method),
      seconds: Number(err.details.wait_seconds),
    }
  }
  return null
}

/** A file's failure as `tg media download` of that message alone reports it */
function failureOf(
  chatId: number,
  messageId: number,
  err: unknown,
): FileFailure {
  const ids = { chatId, messageId }
  if (err instanceof MediaError) {
    return {
      code: err.code,
      message: err.message,
      details: { ...ids, ...err.details },
      suggestion: err.suggestion,
    }
  }
  const wait = rateLimitWait(err)
  if (wait) {
    return {
      code: ErrorCodes.RATE_LIMITED,
      message: `Rate limited for ${wait.method}. Wait ${wait.seconds}s before retrying.`,
      details: { ...ids, method: wait.method, wait_seconds: wait.seconds },
    }
  }
  const message = err instanceof Error ? err.message : 'Unknown error'
  return {
    code: ErrorCodes.TELEGRAM_ERROR,
    message: `Failed to download media: ${message}`,
    details: ids,
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** Flood waits shared by every file of the batch */
function createPause(signal?: AbortSignal) {
  let until = 0
  return {
    /** Pause the batch for `seconds`; false when the wait is too long */
    start(method: string, seconds: number): boolean {
      if (seconds > MAX_BATCH_FLOOD_WAIT_SECONDS) return false
      const now = Date.now()
      if (until <= now) {
        info(`[flood-wait] ${method}: pausing the batch for ${seconds}s`)
      }
      until = Math.max(until, now + seconds * 1000)
      return true
    },
    wait: () => sleep(until - Date.now(), signal),
  }
}

/**
 * The messages in one call per 100 IDs, written to the cache, each kept as
 * the response to its own getMessages (an empty one for an ID Telegram
 * doesn't have in this chat)
 */
async function fetchAll(
  client: TelegramClient,
  chat: HistoryChat,
  ids: number[],
  deps: DownloadDeps,
  pause: ReturnType<typeof createPause>,
): Promise<Map<number, MessagesResponse>> {
  const responses = new Map<number, MessagesResponse>()
  const peer = chat.inputPeer
  for (let at = 0; at < ids.length; at += IDS_PER_FETCH) {
    const id = ids
      .slice(at, at + IDS_PER_FETCH)
      .map((messageId) => ({ _: 'inputMessageID' as const, id: messageId }))
    let response: tl.messages.TypeMessages
    for (;;) {
      await pause.wait()
      try {
        response =
          peer._ === 'inputPeerChannel'
            ? await client.call(
                {
                  _: 'channels.getMessages',
                  channel: {
                    _: 'inputChannel',
                    channelId: peer.channelId,
                    accessHash: peer.accessHash,
                  },
                  id,
                },
                { abortSignal: deps.signal },
              )
            : await client.call(
                { _: 'messages.getMessages', id },
                { abortSignal: deps.signal },
              )
        break
      } catch (err) {
        const wait = rateLimitWait(err)
        if (!wait || !pause.start(wait.method, wait.seconds)) throw err
      }
    }
    if (response._ === 'messages.messagesNotModified') continue
    for (const item of response.messages) {
      if (item._ === 'messageEmpty') continue
      const message = item as FetchedRawMessage
      cacheFetchedMessage(deps.cacheDb, chat.chatId, message, response.users)
      responses.set(message.id, { ...response, messages: [message] })
    }
  }
  for (const messageId of ids) {
    if (!responses.has(messageId)) {
      responses.set(messageId, {
        _: 'messages.messages',
        messages: [],
        topics: [],
        chats: [],
        users: [],
      })
    }
  }
  return responses
}

/**
 * The client each file's download runs on: a getMessages of one prefetched
 * ID is answered from the batch fetch once per try of the file (a file
 * reference Telegram rejects is fetched again), and users.getFullUser, the
 * protection check of a private chat, is called once per batch
 */
function batchClient(
  client: TelegramClient,
  prefetched: Map<number, MessagesResponse>,
) {
  const served = new Map<number, MessagesResponse>()
  const facade = Object.create(client) as TelegramClient
  const fullUsers = new Map<string, Promise<unknown>>()
  facade.call = ((
    request: Parameters<TelegramClient['call']>[0],
    options?: Parameters<TelegramClient['call']>[1],
  ) => {
    if (
      request._ === 'messages.getMessages' ||
      request._ === 'channels.getMessages'
    ) {
      const [only] = request.id
      if (request.id.length === 1 && only?._ === 'inputMessageID') {
        const hit = prefetched.get(only.id)
        if (hit) {
          prefetched.delete(only.id)
          served.set(only.id, hit)
          return Promise.resolve(hit)
        }
      }
    }
    if (request._ === 'users.getFullUser') {
      const key = JSON.stringify(request.id)
      let pending = fullUsers.get(key)
      if (!pending) {
        pending = client.call(request, options).catch((err: unknown) => {
          fullUsers.delete(key)
          throw err
        })
        fullUsers.set(key, pending)
      }
      return pending
    }
    return client.call(request, options)
  }) as TelegramClient['call']
  return {
    client: facade,
    /** Serve the message again: the file sat out a flood wait */
    retry(messageId: number) {
      const hit = served.get(messageId)
      if (hit) prefetched.set(messageId, hit)
    },
  }
}

interface QueuedFile {
  messageId: number
  large: boolean
  waits: number
}

/**
 * Download the files of several messages of one chat. Files the cache holds
 * are served first, without network; the rest download at most
 * MAX_PARALLEL_FILES at a time (MAX_PARALLEL_LARGE_FILES of 20 MB or more).
 * A failed file never stops the others. Resolves with the number of failed
 * files; throws DownloadInterruptedError on SIGINT/SIGTERM, and errors that
 * fail every file (--chat, credentials, the fetch of the messages).
 */
export async function downloadBatch(
  deps: DownloadDeps,
  request: BatchRequest,
  handlers: BatchHandlers,
): Promise<number> {
  const chat = await resolveHistoryChat(
    deps.history.client,
    request.chat,
    deps.history,
  )
  let failures = 0
  const fail = (messageId: number, err: unknown) => {
    failures++
    handlers.failed(messageId, failureOf(chat.chatId, messageId, err))
  }
  const finish = async (result: DownloadResult) => {
    try {
      await handlers.done(result)
    } catch (err) {
      fail(result.messageId, err)
    }
  }
  const single = (messageId: number) => ({
    chat: request.chat,
    messageId,
    thumb: request.thumb,
    fresh: request.fresh,
  })

  const online: number[] = []
  for (const messageId of request.messageIds) {
    if (request.fresh) {
      online.push(messageId)
      continue
    }
    try {
      const cached = readFromCache(deps, chat, single(messageId))
      if (cached) await finish(cached)
      else online.push(messageId)
    } catch (err) {
      fail(messageId, err)
    }
  }
  if (online.length === 0) return failures

  const pause = createPause(deps.signal)
  const client = deps.getClient()
  const prefetched = await fetchAll(client, chat, online, deps, pause).catch(
    (err: unknown) => {
      throw deps.signal?.aborted
        ? new DownloadInterruptedError(null, null)
        : err
    },
  )
  const files = batchClient(client, prefetched)
  const fileDeps: DownloadDeps = {
    ...deps,
    getClient: () => files.client,
    // Concurrent progress lines would overwrite each other
    progress: undefined,
  }

  const messages = createMessagesCache(deps.cacheDb)
  const queue: QueuedFile[] = online.map((messageId) => {
    const row = messages.get(chat.chatId, messageId)
    const size = row ? (extractAttachment(row.raw_json)?.size ?? 0) : 0
    return {
      messageId,
      large: !request.thumb && size >= LARGE_FILE_BYTES,
      waits: 0,
    }
  })

  let interrupted: DownloadInterruptedError | null = null
  const run = async (file: QueuedFile) => {
    await pause.wait()
    if (deps.signal?.aborted) {
      interrupted ??= new DownloadInterruptedError(null, null)
      return
    }
    try {
      await finish(await downloadMedia(fileDeps, single(file.messageId)))
    } catch (err) {
      if (err instanceof DownloadInterruptedError) {
        interrupted ??= err
        return
      }
      const wait = rateLimitWait(err)
      if (
        wait &&
        file.waits < MAX_WAITS_PER_FILE &&
        pause.start(wait.method, wait.seconds)
      ) {
        file.waits++
        files.retry(file.messageId)
        queue.unshift(file)
        return
      }
      fail(file.messageId, err)
    }
  }

  await new Promise<void>((resolve) => {
    let active = 0
    let activeLarge = 0
    const pump = () => {
      if (interrupted) queue.length = 0
      while (active < MAX_PARALLEL_FILES) {
        const index = queue.findIndex(
          (file) => !file.large || activeLarge < MAX_PARALLEL_LARGE_FILES,
        )
        if (index < 0) break
        const [file] = queue.splice(index, 1)
        if (!file) break
        active++
        if (file.large) activeLarge++
        void run(file).finally(() => {
          active--
          if (file.large) activeLarge--
          pump()
        })
      }
      if (active === 0 && queue.length === 0) resolve()
    }
    pump()
  })

  if (interrupted) throw interrupted
  return failures
}
