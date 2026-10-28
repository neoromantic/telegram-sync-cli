/**
 * `tg send --file`: upload one file through the account's rate-limited
 * client and send it with messages.sendMedia, as a photo or a document
 */
import { basename } from 'node:path'
import type { TelegramClient, tl } from '@mtcute/bun'
import { uploadFile } from '@mtcute/bun/methods.js'

import { type AttachmentInfo, extractAttachment } from '../../utils/attachment'
import { toLong } from '../../utils/long'
import { transferClient } from '../../utils/telegram-transfer'

export type SendFileKind = 'photo' | 'document'

/** Images Telegram shows as a photo; anything else is sent as a document */
const PHOTO_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])
/** Telegram's limit for a photo: a bigger image is sent as a document */
export const PHOTO_MAX_BYTES = 10 * 1024 * 1024

/** A photo for a JPEG, PNG or WebP image up to 10 MB, otherwise a document */
export function chooseSendKind(
  mime: string,
  size: number,
  forceDocument: boolean,
): SendFileKind {
  return !forceDocument && PHOTO_MIME_TYPES.has(mime) && size <= PHOTO_MAX_BYTES
    ? 'photo'
    : 'document'
}

/** MIME type from the file's extension, without parameters such as `;charset=utf-8` */
export function fileMimeType(path: string): string {
  const type = Bun.file(path).type.split(';')[0]?.trim()
  return type || 'application/octet-stream'
}

export interface SendFileRequest {
  peer: tl.TypeInputPeer
  /** A readable regular file */
  path: string
  caption: string
  silent: boolean
  replyTo?: number
  forceDocument: boolean
  progress?: (sent: number, total: number) => void
}

export interface SentFile {
  result: tl.TypeUpdates
  kind: SendFileKind
  /** The name Telegram shows: the file's base name, never its directory */
  fileName: string
  mimeType: string
  size: number
}

export interface SendFileDeps {
  /** Tests inject a fake upload */
  upload?: typeof uploadFile
}

/**
 * Upload the file and send it. The free `uploadFile` gets the transfer
 * facade of our client, so every upload.saveFilePart goes through the
 * rate-limit wrapper like other calls.
 */
export async function sendFile(
  client: TelegramClient,
  request: SendFileRequest,
  deps: SendFileDeps = {},
): Promise<SentFile> {
  const file = Bun.file(request.path)
  const fileName = basename(request.path)
  const size = file.size
  const mimeType = fileMimeType(request.path)
  const kind = chooseSendKind(mimeType, size, request.forceDocument)

  const upload = deps.upload ?? uploadFile
  // A stream, not the BunFile: mtcute would send a BunFile's full local
  // path as the file name
  const uploaded = await upload(transferClient(client), {
    file: file.stream(),
    fileName,
    fileSize: size,
    fileMime: mimeType,
    progressCallback: request.progress,
  })

  const media: tl.TypeInputMedia =
    kind === 'photo'
      ? { _: 'inputMediaUploadedPhoto', file: uploaded.inputFile }
      : {
          _: 'inputMediaUploadedDocument',
          file: uploaded.inputFile,
          mimeType: uploaded.mime,
          attributes: [{ _: 'documentAttributeFilename', fileName }],
          forceFile: request.forceDocument || undefined,
        }

  const sendRequest: tl.messages.RawSendMediaRequest = {
    _: 'messages.sendMedia',
    peer: request.peer,
    media,
    message: request.caption,
    randomId: toLong(
      BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
    ),
    silent: request.silent,
  }
  if (request.replyTo) {
    sendRequest.replyTo = {
      _: 'inputReplyToMessage',
      replyToMsgId: request.replyTo,
    }
  }

  const result = await client.call(sendRequest)
  return { result, kind, fileName, mimeType: uploaded.mime, size }
}

/** The file of the message a messages.sendMedia response carries */
export function sentAttachment(result: tl.TypeUpdates): AttachmentInfo | null {
  if (result._ === 'updateShortSentMessage') return extractAttachment(result)
  if (!('updates' in result)) return null
  for (const update of result.updates) {
    if (
      update._ === 'updateNewMessage' ||
      update._ === 'updateNewChannelMessage'
    ) {
      const attachment = extractAttachment(update.message)
      if (attachment) return attachment
    }
  }
  return null
}
