/**
 * The core of `tg media download`: cache-first, so a file already in the
 * account's media cache needs no network and no credentials. Otherwise the
 * message is fetched again (a fresh file reference, its protection checked
 * online) and the file downloaded to a partial download that a later run
 * resumes, then renamed into the cache.
 */
import type { Database } from 'bun:sqlite'
import { open, rename, rm, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  Document,
  type FileDownloadLocation,
  MtTimeoutError,
  MtUnsupportedError,
  Photo,
  type TelegramClient,
  Thumbnail,
  tl,
} from '@mtcute/bun'
import { downloadAsIterable } from '@mtcute/bun/methods.js'

import { createChatProtectionStore } from '../../db/chat-protection'
import { createMessagesCache } from '../../db/messages-cache'
import {
  createRateLimitsService,
  type RateLimitsService,
} from '../../db/rate-limits'
import { ErrorCodes } from '../../types'
import {
  type AttachmentInfo,
  type AttachmentKind,
  attachmentMedia,
  extractAttachment,
  type MediaThumb,
  pickThumb,
} from '../../utils/attachment'
import {
  acquireDownloadLock,
  cachedFileName,
  DownloadLockTimeoutError,
  findCachedFile,
  type MediaCachePaths,
  mediaPaths,
  thumbPaths,
  touch,
} from '../../utils/media-cache'
import { resolveRawMessageType } from '../../utils/message-type'
import { isRateLimitError } from '../../utils/telegram-rate-limits'
import { transferClient } from '../../utils/telegram-transfer'
import type { HistoryClient } from '../messages/helpers'
import {
  type HistoryChat,
  type ResolveHistoryChatDeps,
  resolveHistoryChat,
} from '../messages/history'
import { DownloadInterruptedError, MediaError } from './errors'
import {
  cacheFetchedMessage,
  type FetchedRawMessage,
  fetchMessageById,
} from './fetch'
import {
  checkCachedProtection,
  checkOnlineProtection,
  knownChatProtection,
  type ProtectionReason,
} from './protection'

/**
 * Download part size. A partial download resumes from a multiple of it:
 * upload.getFile wants an offset divisible by 4096 and a request that
 * stays inside one 1 MB block, which any 4096 multiple plus 512 KB parts
 * would cross.
 */
export const PART_SIZE_KB = 512
export const PART_BYTES = PART_SIZE_KB * 1024
/** A download that receives nothing for this long ends with NETWORK_ERROR */
export const STALL_TIMEOUT_MS = 60_000

const GET_FILE = 'upload.getFile'

type ProgressCallback = (done: number, total: number) => void

export interface DownloadDeps {
  /** The account's cache */
  cacheDb: Database
  /** The account's media cache, accounts/<id>/media */
  mediaDir: string
  /** Lazy: calling it is the first thing that needs credentials */
  getClient: () => TelegramClient
  /** Resolves --chat, offline for cached peers (openHistory()) */
  history: ResolveHistoryChatDeps & { client: HistoryClient }
  now?: () => number
  stallTimeoutMs?: number
  /** Aborted on SIGINT/SIGTERM: the partial download is kept */
  signal?: AbortSignal
  /** Progress for the file being downloaded, undefined when nobody watches */
  progress?: (fileName: string) => ProgressCallback | undefined
  /** Tests inject a fake transfer */
  download?: typeof downloadAsIterable
  /** Where flood waits of the transfer are recorded; cacheDb's by default */
  rateLimits?: RateLimitsService
  /** How long to wait for another process's download of the file */
  lockWaitMs?: number
}

export interface DownloadRequest {
  chat: string
  messageId: number
  thumb: boolean
  fresh: boolean
}

/**
 * path, fileName, mimeType, size and uniqueFileId describe what was
 * downloaded: with --thumb the preview, never the original
 */
export interface DownloadResult {
  /** The file in the media cache */
  path: string
  fileName: string
  mimeType: string | null
  size: number
  kind: AttachmentKind | 'thumbnail'
  chatId: number
  messageId: number
  uniqueFileId: string
  /** The message's album ID */
  groupedId: string | null
  /** True when no bytes were downloaded this run */
  cached: boolean
  /** Byte offset a partial download continued from */
  resumedFrom: number | null
  thumb: { type: string; width: number; height: number } | null
}

/** What a run downloads: the original file, or its preview with --thumb */
interface DownloadTarget {
  paths: MediaCachePaths
  /** Bytes the complete file has, when Telegram gives it */
  expectedSize: number | null
  fileName: string
  mimeType: string | null
  uniqueFileId: string
  kind: AttachmentKind | 'thumbnail'
  thumb: MediaThumb | null
}

function downloadTarget(
  mediaDir: string,
  info: AttachmentInfo,
  thumb: MediaThumb | null,
): DownloadTarget {
  if (!thumb) {
    return {
      paths: mediaPaths(mediaDir, info),
      expectedSize: info.size,
      fileName: cachedFileName(info),
      mimeType: info.mimeType,
      uniqueFileId: info.uniqueFileId,
      kind: info.kind,
      thumb: null,
    }
  }
  const paths = thumbPaths(mediaDir, info, thumb)
  return {
    paths,
    expectedSize: thumb.size,
    fileName: basename(paths.file),
    mimeType: info.kind === 'sticker' ? 'image/webp' : 'image/jpeg',
    uniqueFileId: thumb.uniqueFileId,
    kind: 'thumbnail',
    thumb,
  }
}

interface MessageRef {
  chatId: number
  messageId: number
  groupedId: string | null
}

function toResult(
  target: DownloadTarget,
  ref: MessageRef,
  file: { path: string; size: number },
  transfer: { cached: boolean; resumedFrom: number | null },
): DownloadResult {
  return {
    path: file.path,
    fileName: target.fileName,
    mimeType: target.mimeType,
    size: file.size,
    kind: target.kind,
    chatId: ref.chatId,
    messageId: ref.messageId,
    uniqueFileId: target.uniqueFileId,
    groupedId: ref.groupedId,
    cached: transfer.cached,
    resumedFrom: transfer.resumedFrom,
    thumb: target.thumb
      ? {
          type: target.thumb.type,
          width: target.thumb.width,
          height: target.thumb.height,
        }
      : null,
  }
}

function noMedia(
  chatId: number,
  messageId: number,
  messageType: string,
  suggestion?: string,
): MediaError {
  return new MediaError(
    ErrorCodes.NO_MEDIA,
    `Message ${messageId} in chat ${chatId} has no file to download`,
    { chatId, messageId, messageType },
    suggestion,
  )
}

function noThumbnail(chatId: number, messageId: number): MediaError {
  return new MediaError(
    ErrorCodes.NO_MEDIA,
    `The file of message ${messageId} in chat ${chatId} has no preview`,
    { chatId, messageId, reason: 'no_thumbnail' },
    'download the file without --thumb',
  )
}

const PROTECTION_MESSAGES: Record<ProtectionReason, string> = {
  message: 'This message has content protection',
  chat: 'This chat has content protection',
  private_chat: 'This private chat has content protection',
  self_destructing: 'This media self-destructs',
}

function contentProtected(
  chatId: number,
  messageId: number,
  reason: ProtectionReason,
  suggestion?: string,
): MediaError {
  return new MediaError(
    ErrorCodes.CONTENT_PROTECTED,
    `${PROTECTION_MESSAGES[reason]}: Telegram doesn't allow saving its media`,
    { chatId, messageId, reason },
    suggestion,
  )
}

function lockTimeout(err: DownloadLockTimeoutError): MediaError {
  const holder = err.holder === null ? '' : ` (pid ${err.holder})`
  return new MediaError(
    ErrorCodes.GENERAL_ERROR,
    `Another tg process${holder} is still downloading this file after ${Math.round(err.waitedMs / 1000)}s`,
    {
      lock: err.lockPath,
      pid: err.holder,
      waited_seconds: Math.round(err.waitedMs / 1000),
    },
    'run the command again when the other download ends',
  )
}

/**
 * The file from the cache alone: the cached message, its protection as
 * the cache knows it, and the complete file. Null when the message or the
 * file isn't cached; NO_MEDIA or CONTENT_PROTECTED as the cache tells.
 */
function readFromCache(
  deps: DownloadDeps,
  chat: HistoryChat,
  request: DownloadRequest,
): DownloadResult | null {
  const { chatId } = chat
  const { messageId } = request
  const row = createMessagesCache(deps.cacheDb).get(chatId, messageId)
  if (!row) return null

  const info = extractAttachment(row.raw_json)
  if (!info) {
    throw noMedia(
      chatId,
      messageId,
      row.message_type,
      'pass --fresh to fetch the message again',
    )
  }
  const thumb = request.thumb ? pickThumb(row.raw_json) : null
  if (request.thumb && !thumb) throw noThumbnail(chatId, messageId)

  const verdict = checkCachedProtection(
    row.raw_json,
    deps.history.chatsCache.getById(String(chatId)),
    createChatProtectionStore(deps.cacheDb).get(chatId),
  )
  if (verdict.protected) {
    throw contentProtected(
      chatId,
      messageId,
      verdict.reason,
      'pass --fresh to check again',
    )
  }

  const target = downloadTarget(deps.mediaDir, info, thumb)
  const file = findCachedFile(target.paths.file, target.expectedSize)
  if (!file) return null
  touch(file.path)
  return toResult(
    target,
    { chatId, messageId, groupedId: info.groupedId },
    file,
    { cached: true, resumedFrom: null },
  )
}

/** mtcute's location of the file (or preview) in the fresh message */
function fileLocation(
  message: FetchedRawMessage,
  thumb: MediaThumb | null,
): FileDownloadLocation {
  const media = attachmentMedia(message)
  if (!media) throw new Error('The message has no file')
  if (!thumb) {
    return media.file === 'photo'
      ? new Photo(media.raw as unknown as tl.RawPhoto)
      : new Document(media.raw as unknown as tl.RawDocument)
  }
  const owner = media.raw as unknown as tl.RawPhoto | tl.RawDocument
  const sizes: tl.TypePhotoSize[] =
    owner._ === 'photo' ? owner.sizes : (owner.thumbs ?? [])
  const size = sizes.find(
    (item) =>
      (item._ === 'photoSize' || item._ === 'photoSizeProgressive') &&
      item.type === thumb.type,
  )
  if (!size) throw new Error(`The file has no ${thumb.type} preview`)
  return new Thumbnail(owner, size)
}

function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
])

/** Telegram wants a fresh file reference: fetching the message again gives one */
function isFileReferenceError(err: unknown): boolean {
  if (tl.RpcError.is(err)) return err.text.startsWith('FILE_REFERENCE_')
  return err instanceof MtUnsupportedError && /file ref/i.test(err.message)
}

/** Seconds of a 420 error mtcute gives as `seconds` or Telegram as `_N` */
function floodWaitSeconds(err: tl.RpcError): number | null {
  const seconds = (err as { seconds?: unknown }).seconds
  if (typeof seconds === 'number' && seconds > 0) return seconds
  const match = err.text.match(/_(\d+)$/)
  return match ? Number(match[1]) : null
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/**
 * The documented error for a failed transfer: rate limits (recorded for
 * the account), a stall, a CDN file, Telegram's refusal or a lost
 * connection. Anything else is returned as it is.
 */
async function transferError(
  err: unknown,
  target: DownloadTarget,
  stallTimeoutMs: number,
  rateLimits: () => RateLimitsService,
): Promise<unknown> {
  if (isFileReferenceError(err)) {
    const text = tl.RpcError.is(err) ? err.text : (err as Error).message
    return new MediaError(
      ErrorCodes.TELEGRAM_ERROR,
      `Telegram rejected the file reference of a freshly fetched message: ${text}`,
      { method: GET_FILE, error: text },
    )
  }
  if (isRateLimitError(err)) {
    return new MediaError(
      ErrorCodes.RATE_LIMITED,
      `Rate limited for ${err.method}. Wait ${err.waitSeconds}s before retrying.`,
      { method: err.method, wait_seconds: err.waitSeconds },
      'run the command again after the wait to resume',
    )
  }
  if (tl.RpcError.is(err) && err.code === tl.RpcError.FLOOD) {
    const seconds = floodWaitSeconds(err)
    if (seconds !== null) {
      // FLOOD_PREMIUM_WAIT and other waits the rate-limit wrapper can't read
      rateLimits().setFloodWait(GET_FILE, seconds)
      return new MediaError(
        ErrorCodes.RATE_LIMITED,
        `Rate limited for ${GET_FILE}. Wait ${seconds}s before retrying.`,
        { method: GET_FILE, wait_seconds: seconds },
        'run the command again after the wait to resume',
      )
    }
  }
  if (err instanceof MtTimeoutError) {
    return new MediaError(
      ErrorCodes.NETWORK_ERROR,
      `The download stalled: nothing arrived for ${stallTimeoutMs / 1000}s`,
      {
        stalled_seconds: stallTimeoutMs / 1000,
        downloaded_bytes: await sizeOf(target.paths.part),
        resumable: true,
      },
      'run the command again to resume',
    )
  }
  if (err instanceof MtUnsupportedError && /cdn/i.test(err.message)) {
    await rm(target.paths.part, { force: true })
    return new MediaError(
      ErrorCodes.MEDIA_UNSUPPORTED,
      "This file is served from Telegram's CDN, which tg doesn't support yet",
      { reason: 'cdn' },
    )
  }
  if (tl.RpcError.is(err)) {
    return new MediaError(
      ErrorCodes.TELEGRAM_ERROR,
      `Telegram refused the download: ${err.text}`,
      { method: GET_FILE, error: err.text },
    )
  }
  const code = errorCode(err)
  if (code !== undefined && NETWORK_ERROR_CODES.has(code)) {
    return new MediaError(
      ErrorCodes.NETWORK_ERROR,
      `The download failed: ${err instanceof Error ? err.message : String(err)}`,
      { downloaded_bytes: await sizeOf(target.paths.part), resumable: true },
      'run the command again to resume',
    )
  }
  return err
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  chunk: Uint8Array,
): Promise<void> {
  let written = 0
  while (written < chunk.length) {
    const { bytesWritten } = await handle.write(
      chunk,
      written,
      chunk.length - written,
    )
    written += bytesWritten
  }
}

interface StreamOptions {
  client: TelegramClient
  location: FileDownloadLocation
  target: DownloadTarget
  deps: DownloadDeps
  stallTimeoutMs: number
}

/**
 * Download into the partial file, resuming from the last whole part it
 * holds, and rename it into the cache once it is complete. Returns the
 * offset it resumed from. The partial download stays when the transfer
 * fails or is interrupted, unless it can't be resumed.
 */
async function streamToCache({
  client,
  location,
  target,
  deps,
  stallTimeoutMs,
}: StreamOptions): Promise<number | null> {
  const { part, file } = target.paths
  const { expectedSize } = target
  let have = await sizeOf(part)
  if (expectedSize !== null && have > expectedSize) have = 0
  const offset = have - (have % PART_BYTES)

  // Bun has no append API: Bun.file().writer() writes from the start
  const handle = await open(part, 'a', 0o600)
  let size: number
  try {
    await handle.truncate(offset)
    const download = deps.download ?? downloadAsIterable
    const chunks = download(transferClient(client), location, {
      offset,
      partSize: PART_SIZE_KB,
      // An explicit size wins over the location's: a preview's own size
      fileSize: expectedSize ?? undefined,
      stallTimeout: stallTimeoutMs,
      abortSignal: deps.signal,
      progressCallback: deps.progress?.(target.fileName),
    })
    try {
      for await (const chunk of chunks) {
        await writeAll(handle, chunk)
      }
    } catch (err) {
      // Keep what arrived for the next run
      await handle.sync().catch(() => undefined)
      throw err
    }
    await handle.sync()
    size = (await handle.stat()).size
  } finally {
    await handle.close()
  }

  if (expectedSize !== null && size !== expectedSize) {
    await rm(part, { force: true })
    throw new MediaError(
      ErrorCodes.NETWORK_ERROR,
      `The download ended at ${size} of ${expectedSize} bytes`,
      { expected: expectedSize, received: size },
      'run the command again',
    )
  }
  await rename(part, file)
  return offset > 0 ? offset : null
}

/**
 * The file through Telegram: fetch the message again, refuse protected
 * content, then serve the cached file or download it under the folder's
 * lock. A file reference Telegram rejects is refreshed once.
 */
async function downloadOnline(
  deps: DownloadDeps,
  chat: HistoryChat,
  request: DownloadRequest,
): Promise<DownloadResult> {
  const { chatId } = chat
  const { messageId } = request
  const now = deps.now ?? Date.now
  const stallTimeoutMs = deps.stallTimeoutMs ?? STALL_TIMEOUT_MS
  const rateLimits = () =>
    deps.rateLimits ?? createRateLimitsService(deps.cacheDb)
  const protection = createChatProtectionStore(deps.cacheDb)
  const client = deps.getClient()

  for (let attempt = 1; ; attempt++) {
    const { message, chats, users } = await fetchMessageById(
      client,
      chat,
      messageId,
      deps.signal,
    )
    cacheFetchedMessage(deps.cacheDb, chatId, message, users)

    const info = extractAttachment(message)
    if (!info) {
      throw noMedia(
        chatId,
        messageId,
        resolveRawMessageType(message).messageType,
      )
    }
    const thumb = request.thumb ? pickThumb(message) : null
    if (request.thumb && !thumb) throw noThumbnail(chatId, messageId)

    const verdict = await checkOnlineProtection(
      client,
      chat,
      message,
      chats,
      deps.signal,
    )
    // A negative answer too: protection turned off clears the block
    if (verdict.chat) protection.record(chatId, verdict.chat, now())
    if (verdict.message.protected) {
      throw contentProtected(chatId, messageId, verdict.message.reason)
    }
    if (verdict.chat?.protected && verdict.chat.reason) {
      throw contentProtected(chatId, messageId, verdict.chat.reason)
    }
    if (!verdict.chat) {
      // Telegram sent no chat object: the protection last known holds
      const known = knownChatProtection(
        deps.history.chatsCache.getById(String(chatId)),
        protection.get(chatId),
      )
      if (known.protected) {
        throw contentProtected(chatId, messageId, known.reason)
      }
    }

    const target = downloadTarget(deps.mediaDir, info, thumb)
    const ref = { chatId, messageId, groupedId: info.groupedId }
    const servedFromCache = () => {
      const file = findCachedFile(target.paths.file, target.expectedSize)
      if (!file) return null
      touch(file.path)
      return toResult(target, ref, file, { cached: true, resumedFrom: null })
    }

    const cached = servedFromCache()
    if (cached) return cached

    const release = await acquireDownloadLock(target.paths.lock, {
      signal: deps.signal,
      waitMs: deps.lockWaitMs,
    }).catch((err: unknown) => {
      throw err instanceof DownloadLockTimeoutError ? lockTimeout(err) : err
    })
    try {
      // Another process may have finished it meanwhile
      const finished = servedFromCache()
      if (finished) return finished

      let resumedFrom: number | null
      try {
        resumedFrom = await streamToCache({
          client,
          location: fileLocation(message, thumb),
          target,
          deps,
          stallTimeoutMs,
        })
      } catch (err) {
        if (deps.signal?.aborted) {
          throw new DownloadInterruptedError(
            await sizeOf(target.paths.part),
            target.expectedSize,
          )
        }
        if (attempt === 1 && isFileReferenceError(err)) continue
        throw await transferError(err, target, stallTimeoutMs, rateLimits)
      }

      const size = target.expectedSize ?? (await sizeOf(target.paths.file))
      return toResult(
        target,
        ref,
        { path: target.paths.file, size },
        { cached: false, resumedFrom },
      )
    } finally {
      release()
    }
  }
}

/**
 * Download a message's file (or its preview) into the account's media
 * cache. From the cache alone when it holds the file and `fresh` is off:
 * then no client is created.
 */
export async function downloadMedia(
  deps: DownloadDeps,
  request: DownloadRequest,
): Promise<DownloadResult> {
  const chat = await resolveHistoryChat(
    deps.history.client,
    request.chat,
    deps.history,
  )
  if (!request.fresh) {
    const cached = readFromCache(deps, chat, request)
    if (cached) return cached
  }
  try {
    return await downloadOnline(deps, chat, request)
  } catch (err) {
    // Stopped before the transfer: fetching the message or waiting for the lock
    if (deps.signal?.aborted && !(err instanceof DownloadInterruptedError)) {
      throw new DownloadInterruptedError(null, null)
    }
    throw err
  }
}
