/**
 * Tests for sending one file with `tg send --file` (src/commands/send/send-file.ts)
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TelegramClient, tl } from '@mtcute/bun'
import type { uploadFile } from '@mtcute/bun/methods.js'

import {
  chooseSendKind,
  fileMimeType,
  PHOTO_MAX_BYTES,
  sendFile,
  sentAttachment,
} from '../commands/send/send-file'
import { extractAttachment } from '../utils/attachment'
import { toLong } from '../utils/long'
import { MEDIA_FLOOD_SLEEP_MS } from '../utils/telegram-transfer'
import { pdfDocumentMessage } from './helpers/media-messages'
import { fakeBytes, photoMessage } from './helpers/photo-message'

const SELF_ID = 5_550_001
const SELF = { _: 'peerUser' as const, userId: SELF_ID }
const DATE = 1_760_000_000

type UploadParams = Parameters<typeof uploadFile>[1]

interface UploadCall {
  client: TelegramClient
  params: UploadParams
  bytes: Uint8Array
}

/** An upload that reads the stream it gets and makes one part call */
function fakeUpload() {
  const calls: UploadCall[] = []
  const upload = (async (client: TelegramClient, params: UploadParams) => {
    const stream = params.file as ReadableStream<Uint8Array>
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    calls.push({ client, params, bytes })
    await client.call(
      {
        _: 'upload.saveFilePart',
        fileId: toLong(77),
        filePart: 0,
        bytes,
      },
      { floodSleepThreshold: Number.POSITIVE_INFINITY },
    )
    params.progressCallback?.(bytes.length, bytes.length)
    return {
      inputFile: {
        _: 'inputFile',
        id: toLong(77),
        parts: 1,
        name: params.fileName ?? 'unnamed',
        md5Checksum: '',
      },
      size: bytes.length,
      mime: params.fileMime ?? 'application/octet-stream',
    }
  }) as unknown as typeof uploadFile
  return { upload, calls }
}

/** A sendMedia answer for a made-up message (helpers type it loosely) */
function sentUpdates(made: { id: number }): tl.TypeUpdates {
  const message = made as unknown as tl.RawMessage
  return {
    _: 'updates',
    updates: [
      { _: 'updateMessageID', id: message.id, randomId: toLong(1) },
      { _: 'updateNewMessage', message, pts: 1, ptsCount: 1 },
    ],
    users: [],
    chats: [],
    date: DATE,
    seq: 0,
  }
}

/** A client whose call() answers messages.sendMedia with `response` */
function fakeClient(response: tl.TypeUpdates) {
  const call = mock(async (request: { _: string }, _options?: unknown) =>
    request._ === 'messages.sendMedia' ? response : true,
  )
  return { client: { call } as unknown as TelegramClient, call }
}

function sendMediaRequest(
  call: ReturnType<typeof fakeClient>['call'],
): tl.messages.RawSendMediaRequest {
  const request = call.mock.calls
    .map(([request]) => request)
    .find((request) => request._ === 'messages.sendMedia')
  expect(request).toBeDefined()
  return request as tl.messages.RawSendMediaRequest
}

describe('chooseSendKind', () => {
  it('sends JPEG, PNG and WebP images up to 10 MB as photos', () => {
    expect(chooseSendKind('image/jpeg', 1_000, false)).toBe('photo')
    expect(chooseSendKind('image/png', PHOTO_MAX_BYTES, false)).toBe('photo')
    expect(chooseSendKind('image/webp', 50_000, false)).toBe('photo')
  })

  it('sends everything else as a document', () => {
    expect(chooseSendKind('image/gif', 1_000, false)).toBe('document')
    expect(chooseSendKind('image/png', 11 * 1024 * 1024, false)).toBe(
      'document',
    )
    expect(chooseSendKind('application/pdf', 1_000, false)).toBe('document')
    expect(chooseSendKind('video/mp4', 1_000, false)).toBe('document')
  })

  it('sends an image as a document when asked', () => {
    expect(chooseSendKind('image/jpeg', 1_000, true)).toBe('document')
  })
})

describe('fileMimeType', () => {
  it('reads the type from the extension, without parameters', () => {
    expect(fileMimeType('holiday.JPG')).toBe('image/jpeg')
    expect(fileMimeType('notes.txt')).toBe('text/plain')
    expect(fileMimeType('report.pdf')).toBe('application/pdf')
  })

  it('falls back to application/octet-stream', () => {
    expect(fileMimeType('README')).toBe('application/octet-stream')
    expect(fileMimeType('data.unknownext')).toBe('application/octet-stream')
  })
})

describe('sendFile', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tg-send-file-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function place(name: string, size: number): string {
    const dir = join(root, 'nested', 'dir')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, fakeBytes(size, 5))
    return path
  }

  it('uploads a PNG as a photo with the caption, silent and reply', async () => {
    const path = place('lake.png', 2_000)
    const response = sentUpdates(photoMessage(SELF, 42))
    const { client, call } = fakeClient(response)
    const { upload, calls } = fakeUpload()
    const progress = mock((_sent: number, _total: number) => {})

    const sent = await sendFile(
      client,
      {
        peer: { _: 'inputPeerSelf' },
        path,
        caption: 'The example lake',
        silent: true,
        replyTo: 7,
        forceDocument: false,
        progress,
      },
      { upload },
    )

    expect(sent).toMatchObject({
      result: response,
      kind: 'photo',
      fileName: 'lake.png',
      mimeType: 'image/png',
      size: 2_000,
    })
    // The upload reads the file as a stream and names it by its base name
    expect(calls).toHaveLength(1)
    expect(calls[0]?.bytes).toEqual(fakeBytes(2_000, 5))
    expect(calls[0]?.params).toMatchObject({
      fileName: 'lake.png',
      fileSize: 2_000,
      fileMime: 'image/png',
    })
    expect(progress).toHaveBeenCalledWith(2_000, 2_000)

    const request = sendMediaRequest(call)
    expect(request).toMatchObject({
      peer: { _: 'inputPeerSelf' },
      message: 'The example lake',
      silent: true,
      replyTo: { _: 'inputReplyToMessage', replyToMsgId: 7 },
      media: {
        _: 'inputMediaUploadedPhoto',
        file: { _: 'inputFile', name: 'lake.png' },
      },
    })
    expect(request.randomId).toBeDefined()
  })

  it('uploads through the transfer facade of the client', async () => {
    const path = place('lake.jpg', 100)
    const { client, call } = fakeClient(sentUpdates(photoMessage(SELF, 42)))
    const { upload, calls } = fakeUpload()

    await sendFile(
      client,
      {
        peer: { _: 'inputPeerSelf' },
        path,
        caption: '',
        silent: false,
        forceDocument: false,
      },
      { upload },
    )

    expect(calls[0]?.client).not.toBe(client)
    expect(Object.getPrototypeOf(calls[0]?.client)).toBe(client)
    // The part reached our client, which the rate-limit wrapper wraps
    const part = call.mock.calls.find(
      ([request]) => request._ === 'upload.saveFilePart',
    )
    expect(part?.[1]).toEqual({ floodSleepThreshold: MEDIA_FLOOD_SLEEP_MS })
  })

  it('sends a PDF as a document named by its base name', async () => {
    const path = place('example-report.pdf', 1_500)
    const { client, call } = fakeClient(
      sentUpdates(pdfDocumentMessage(SELF, 43)),
    )
    const { upload } = fakeUpload()

    const sent = await sendFile(
      client,
      {
        peer: { _: 'inputPeerSelf' },
        path,
        caption: '',
        silent: false,
        forceDocument: false,
      },
      { upload },
    )

    expect(sent.kind).toBe('document')
    const request = sendMediaRequest(call)
    expect(request.replyTo).toBeUndefined()
    expect(request.media).toEqual({
      _: 'inputMediaUploadedDocument',
      file: {
        _: 'inputFile',
        id: toLong(77),
        parts: 1,
        name: 'example-report.pdf',
        md5Checksum: '',
      },
      mimeType: 'application/pdf',
      attributes: [
        { _: 'documentAttributeFilename', fileName: 'example-report.pdf' },
      ],
      forceFile: undefined,
    })
  })

  it('sends an image as a file with forceDocument', async () => {
    const path = place('lake.jpg', 100)
    const { client, call } = fakeClient(
      sentUpdates(pdfDocumentMessage(SELF, 44)),
    )
    const { upload } = fakeUpload()

    const sent = await sendFile(
      client,
      {
        peer: { _: 'inputPeerSelf' },
        path,
        caption: '',
        silent: false,
        forceDocument: true,
      },
      { upload },
    )

    expect(sent).toMatchObject({ kind: 'document', mimeType: 'image/jpeg' })
    expect(sendMediaRequest(call).media).toMatchObject({
      _: 'inputMediaUploadedDocument',
      mimeType: 'image/jpeg',
      forceFile: true,
      attributes: [{ _: 'documentAttributeFilename', fileName: 'lake.jpg' }],
    })
  })
})

describe('sentAttachment', () => {
  it('reads the file of the sent message from updates', () => {
    const message = pdfDocumentMessage(SELF, 43)
    expect(sentAttachment(sentUpdates(message))).toEqual(
      extractAttachment(message),
    )
    expect(sentAttachment(sentUpdates(message))).toMatchObject({
      kind: 'document',
      fileName: 'example-report.pdf',
    })
  })

  it('reads the media of updateShortSentMessage', () => {
    const { media } = photoMessage(SELF, 45)
    const attachment = sentAttachment({
      _: 'updateShortSentMessage',
      out: true,
      id: 45,
      pts: 1,
      ptsCount: 1,
      date: DATE,
      media,
    })
    expect(attachment).toMatchObject({ kind: 'photo', mimeType: 'image/jpeg' })
  })

  it('is null without a message that has a file', () => {
    expect(
      sentAttachment({
        _: 'updates',
        updates: [{ _: 'updateMessageID', id: 1, randomId: toLong(1) }],
        users: [],
        chats: [],
        date: DATE,
        seq: 0,
      }),
    ).toBeNull()
    expect(sentAttachment({ _: 'updatesTooLong' })).toBeNull()
  })
})
