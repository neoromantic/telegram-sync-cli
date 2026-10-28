/**
 * The core of `tg media download` (src/commands/media/download-media.ts):
 * cache hits without a client, the online path with a fake Telegram client
 * and an injected transfer, resume, errors and content protection. Made-up
 * messages and files in temp dirs only.
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  Document,
  Long,
  MtTimeoutError,
  MtUnsupportedError,
  Photo,
  type TelegramClient,
  Thumbnail,
  tl,
} from '@mtcute/bun'

import {
  type DownloadDeps,
  type DownloadRequest,
  downloadMedia,
  PART_BYTES,
  PART_SIZE_KB,
  STALL_TIMEOUT_MS,
} from '../commands/media/download-media'
import { DownloadInterruptedError, MediaError } from '../commands/media/errors'
import { fetchMessageById } from '../commands/media/fetch'
import type { HistoryClient } from '../commands/messages/helpers'
import { createDmLookup } from '../commands/send/peer-resolver'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import {
  type ChatProtectionReason,
  createChatProtectionStore,
} from '../db/chat-protection'
import { createChatsCache } from '../db/chats-cache'
import { createMessageAttachmentsStore } from '../db/message-attachments'
import { createMessagesCache } from '../db/messages-cache'
import { createRateLimitsService } from '../db/rate-limits'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import { type Account, ErrorCodes } from '../types'
import { extractAttachment, pickThumb } from '../utils/attachment'
import { mediaPaths, thumbPaths } from '../utils/media-cache'
import { RateLimitError } from '../utils/telegram-rate-limits'
import { MEDIA_FLOOD_SLEEP_MS } from '../utils/telegram-transfer'
import { documentMessage, pdfDocumentMessage } from './helpers/media-messages'
import { fakeBytes, photoMessage } from './helpers/photo-message'

const SELF_ID = 5_550_001
const ALICE_ID = 5_550_002
const TEAM_RAW_ID = 1_555_000_001
const TEAM_CHAT_ID = -1_001_555_000_001
const NOW = Date.UTC(2026, 9, 28, 12, 0, 0)

const SELF = { _: 'peerUser' as const, userId: SELF_ID }
const ALICE = { _: 'peerUser' as const, userId: ALICE_ID }
const TEAM = { _: 'peerChannel' as const, channelId: TEAM_RAW_ID }

const ACCOUNT: Account = {
  id: 1,
  phone: '+15550000000',
  user_id: SELF_ID,
  name: 'Example Account',
  username: null,
  label: null,
  session_data: '',
  is_active: 1,
  created_at: '2026-10-01 00:00:00',
  updated_at: '2026-10-01 00:00:00',
}

/** The team channel as getMessages sends it with a message */
function teamChannel(noforwards = false) {
  return {
    _: 'channel' as const,
    id: TEAM_RAW_ID,
    accessHash: Long.fromString('7000000000000000005'),
    title: 'Example Team',
    photo: { _: 'chatPhotoEmpty' as const },
    date: 1_760_000_000,
    megagroup: true,
    ...(noforwards ? { noforwards: true } : {}),
  }
}

let db: Database
let root: string
let mediaDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tg-media-download-'))
  mediaDir = join(root, 'media')
  db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  createUsersCache(db).upsert({
    user_id: String(ALICE_ID),
    first_name: 'Alice',
    last_name: 'Example',
    access_hash: '1111',
    fetched_at: NOW,
    raw_json: '{}',
  })
  createChatsCache(db).upsert({
    chat_id: String(TEAM_CHAT_ID),
    type: 'supergroup',
    title: 'Example Team',
    username: null,
    member_count: 30,
    access_hash: '7000000000000000005',
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: NOW,
    // A dialog row: no chat flags
    raw_json: JSON.stringify({ _: 'dialog', unreadCount: 0 }),
  })
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

// --- Fakes ---

interface FakeTelegram {
  /** The message getMessages answers, per call */
  message: () => unknown
  chats?: unknown[]
  fullUser?: { noforwardsMyEnabled?: boolean; noforwardsPeerEnabled?: boolean }
}

interface RecordedCall {
  request: { _: string } & Record<string, unknown>
  options?: Record<string, unknown>
}

function fakeTelegram(telegram: FakeTelegram) {
  const calls: RecordedCall[] = []
  const client = {
    async call(
      request: RecordedCall['request'],
      options?: RecordedCall['options'],
    ) {
      calls.push({ request, options })
      switch (request._) {
        case 'messages.getMessages':
        case 'channels.getMessages':
          return {
            _:
              request._ === 'channels.getMessages'
                ? 'messages.channelMessages'
                : 'messages.messages',
            messages: [telegram.message()],
            chats: telegram.chats ?? [],
            users: [],
          }
        case 'users.getFullUser':
          return {
            _: 'users.userFull',
            fullUser: { _: 'userFull', id: ALICE_ID, ...telegram.fullUser },
            chats: [],
            users: [],
          }
        case 'upload.getFile':
          return { _: 'upload.file' }
        default:
          throw new Error(`Unexpected call ${request._}`)
      }
    },
  }
  const methods = () => calls.map((call) => call.request._)
  return { client: client as unknown as TelegramClient, calls, methods }
}

type DownloadFn = NonNullable<DownloadDeps['download']>
type DownloadParams = NonNullable<Parameters<DownloadFn>[2]>

interface TransferRun {
  client: TelegramClient
  location: unknown
  params: DownloadParams
}

/** An injected transfer: `produce` yields the chunks of each run */
function fakeTransfer(
  produce: (run: TransferRun, index: number) => AsyncGenerator<Uint8Array>,
) {
  const runs: TransferRun[] = []
  const download = async function* (
    client: TelegramClient,
    location: unknown,
    params: DownloadParams,
  ) {
    const run = { client, location, params }
    runs.push(run)
    yield* produce(run, runs.length - 1)
  }
  return { download: download as unknown as DownloadFn, runs }
}

/** Chunks of the part size, as mtcute yields them */
async function* chunksOf(bytes: Uint8Array) {
  for (let at = 0; at < bytes.length; at += PART_BYTES) {
    yield bytes.subarray(at, at + PART_BYTES)
  }
}

function noClient(): TelegramClient {
  throw new Error('a cache hit needs no client')
}

function historyDeps(): DownloadDeps['history'] {
  const client: HistoryClient = {
    call: (() => {
      throw new Error('--chat resolves offline')
    }) as HistoryClient['call'],
    getMe: () => {
      throw new Error('--chat resolves offline')
    },
  }
  return {
    client,
    usersCache: createUsersCache(db),
    chatsCache: createChatsCache(db),
    dms: createDmLookup(db),
    accounts: {
      getById: () => ACCOUNT,
      getActive: () => ACCOUNT,
      update: () => ACCOUNT,
    },
    accountId: ACCOUNT.id,
  }
}

function deps(overrides: Partial<DownloadDeps> = {}): DownloadDeps {
  return {
    cacheDb: db,
    mediaDir,
    getClient: noClient,
    history: historyDeps(),
    now: () => NOW,
    ...overrides,
  }
}

function request(
  chat: string,
  messageId: number,
  extra: Partial<DownloadRequest> = {},
): DownloadRequest {
  return { chat, messageId, thumb: false, fresh: false, ...extra }
}

function cacheMessage(chatId: number, raw: unknown) {
  const input = parseRawMessage(raw, chatId)
  if (!input) throw new Error('not a message')
  createMessagesCache(db).upsert(input)
}

function place(path: string, bytes: Uint8Array) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

function pathsOf(raw: unknown) {
  const info = extractAttachment(raw)
  if (!info) throw new Error('no attachment')
  return mediaPaths(mediaDir, info)
}

function expectBytes(actual: Uint8Array, expected: Uint8Array) {
  expect(actual.length).toBe(expected.length)
  expect(Buffer.compare(actual, expected)).toBe(0)
}

async function mediaError(promise: Promise<unknown>): Promise<MediaError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the download to fail')
    },
    (reason: unknown) => reason,
  )
  expect(err).toBeInstanceOf(MediaError)
  return err as MediaError
}

/** A made-up 1 MB video with a file name */
function videoMessage(peer: typeof SELF | typeof TEAM, id: number) {
  return documentMessage(peer, id, {
    id: '6000000000000000021',
    mimeType: 'video/mp4',
    size: 1_000_000,
    attributes: [
      { _: 'documentAttributeVideo', duration: 12.5, w: 1280, h: 720 },
      { _: 'documentAttributeFilename', fileName: 'example-clip.mp4' },
    ],
  })
}

const pdf = pdfDocumentMessage(SELF, 5)
const PDF_SIZE = 120_000

// --- Cache hits ---

describe('downloadMedia from the cache', () => {
  it('serves a cached file without a client and marks it used', async () => {
    const photo = photoMessage(SELF, 1)
    cacheMessage(SELF_ID, photo)
    const { file } = pathsOf(photo)
    place(file, fakeBytes(60_000))
    const old = new Date(NOW - 30 * 24 * 60 * 60 * 1000)
    utimesSync(file, old, old)

    const result = await downloadMedia(deps(), request('me', 1))

    expect(result).toEqual({
      path: file,
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 60_000,
      kind: 'photo',
      chatId: SELF_ID,
      messageId: 1,
      uniqueFileId: extractAttachment(photo)!.uniqueFileId,
      groupedId: null,
      cached: true,
      resumedFrom: null,
      thumb: null,
    })
    expect(statSync(file).mtimeMs).toBeGreaterThan(old.getTime())
  })

  it('takes a file of another size as missing and goes online', async () => {
    cacheMessage(SELF_ID, pdf)
    place(pathsOf(pdf).file, fakeBytes(10))

    await expect(downloadMedia(deps(), request('me', 5))).rejects.toThrow(
      'a cache hit needs no client',
    )
  })

  it('reports NO_MEDIA for a cached message without a file', async () => {
    cacheMessage(SELF_ID, {
      _: 'message',
      id: 3,
      peerId: SELF,
      date: 1_760_000_003,
      message: 'Just text',
    })

    const err = await mediaError(downloadMedia(deps(), request('me', 3)))
    expect(err.code).toBe(ErrorCodes.NO_MEDIA)
    expect(err.details).toEqual({
      chatId: SELF_ID,
      messageId: 3,
      messageType: 'text',
    })
    expect(err.suggestion).toContain('--fresh')
  })

  it('reports NO_MEDIA for --thumb when the file has no preview', async () => {
    const zip = documentMessage(SELF, 4, {
      mimeType: 'application/zip',
      attributes: [{ _: 'documentAttributeFilename', fileName: 'notes.zip' }],
      thumbs: [{ _: 'photoStrippedSize', type: 'i', bytes: fakeBytes(10) }],
    })
    cacheMessage(SELF_ID, zip)

    const err = await mediaError(
      downloadMedia(deps(), request('me', 4, { thumb: true })),
    )
    expect(err.code).toBe(ErrorCodes.NO_MEDIA)
    expect(err.details).toMatchObject({ reason: 'no_thumbnail' })
  })

  it('serves a cached preview of its own size with --thumb', async () => {
    cacheMessage(SELF_ID, pdf)
    const info = extractAttachment(pdf)!
    const thumb = pickThumb(pdf)!
    const { file } = thumbPaths(mediaDir, info, thumb)
    place(file, fakeBytes(3_000))

    const result = await downloadMedia(
      deps(),
      request('me', 5, { thumb: true }),
    )

    expect(result).toMatchObject({
      path: file,
      fileName: 'thumb-m.jpg',
      mimeType: 'image/jpeg',
      size: 3_000,
      kind: 'thumbnail',
      uniqueFileId: thumb.uniqueFileId,
      cached: true,
      thumb: { type: 'm', width: 320, height: 180 },
    })
    expect(thumb.uniqueFileId).not.toBe(info.uniqueFileId)
  })
})

describe('downloadMedia: content protection known to the cache', () => {
  it('refuses a message with noforwards, leaving the file in place', async () => {
    const photo = { ...photoMessage(SELF, 1), noforwards: true }
    cacheMessage(SELF_ID, photo)
    const { file } = pathsOf(photo)
    place(file, fakeBytes(60_000))

    const err = await mediaError(downloadMedia(deps(), request('me', 1)))
    expect(err.code).toBe(ErrorCodes.CONTENT_PROTECTED)
    expect(err.details).toEqual({
      chatId: SELF_ID,
      messageId: 1,
      reason: 'message',
    })
    expect(err.suggestion).toContain('--fresh')
    expect(existsSync(file)).toBe(true)
  })

  it('refuses self-destructing media', async () => {
    const base = photoMessage(SELF, 1)
    const photo = { ...base, media: { ...base.media, ttlSeconds: 10 } }
    cacheMessage(SELF_ID, photo)
    place(pathsOf(photo).file, fakeBytes(60_000))

    const err = await mediaError(downloadMedia(deps(), request('me', 1)))
    expect(err.details).toMatchObject({ reason: 'self_destructing' })
  })

  it('refuses a chat the last online check found protected', async () => {
    const photo = photoMessage(ALICE, 2)
    cacheMessage(ALICE_ID, photo)
    place(pathsOf(photo).file, fakeBytes(60_000))
    createChatProtectionStore(db).record(
      ALICE_ID,
      { protected: true, reason: 'private_chat' },
      NOW,
    )

    const err = await mediaError(
      downloadMedia(deps(), request(String(ALICE_ID), 2)),
    )
    expect(err.details).toEqual({
      chatId: ALICE_ID,
      messageId: 2,
      reason: 'private_chat',
    })
  })

  it('refuses a chat whose cached raw chat object has noforwards', async () => {
    const video = videoMessage(TEAM, 8)
    cacheMessage(TEAM_CHAT_ID, video)
    place(pathsOf(video).file, fakeBytes(1_000_000))
    db.query('UPDATE chats_cache SET raw_json = ? WHERE chat_id = ?').run(
      JSON.stringify(teamChannel(true)),
      String(TEAM_CHAT_ID),
    )

    const err = await mediaError(
      downloadMedia(deps(), request(String(TEAM_CHAT_ID), 8)),
    )
    expect(err.details).toMatchObject({ reason: 'chat' })
  })

  it('lets a newer online check that found protection off clear a raw chat flag', async () => {
    const video = videoMessage(TEAM, 8)
    cacheMessage(TEAM_CHAT_ID, video)
    const { file } = pathsOf(video)
    place(file, fakeBytes(1_000_000))
    const setRawChat = (noforwards: boolean, fetchedAt: number) =>
      db
        .query(
          'UPDATE chats_cache SET raw_json = ?, fetched_at = ? WHERE chat_id = ?',
        )
        .run(
          JSON.stringify(teamChannel(noforwards)),
          fetchedAt,
          String(TEAM_CHAT_ID),
        )
    const protection = createChatProtectionStore(db)
    setRawChat(true, NOW - 60_000)
    protection.record(TEAM_CHAT_ID, { protected: false, reason: null }, NOW)

    const hit = await downloadMedia(deps(), request(String(TEAM_CHAT_ID), 8))
    expect(hit).toMatchObject({ cached: true, path: file })

    // The chat object fetched after that check has the flag again
    setRawChat(true, NOW + 60_000)
    const err = await mediaError(
      downloadMedia(deps(), request(String(TEAM_CHAT_ID), 8)),
    )
    expect(err.details).toMatchObject({ reason: 'chat' })
  })
})

// --- Online ---

describe('downloadMedia from Telegram', () => {
  it('downloads a file, caches the message and renames the partial download', async () => {
    const telegram = fakeTelegram({ message: () => pdf })
    const bytes = fakeBytes(PDF_SIZE, 5)
    const transfer = fakeTransfer(async function* (run) {
      // The transfer runs on the facade that sleeps through short waits only
      await run.client.call({ _: 'upload.getFile' } as never)
      yield* chunksOf(bytes)
    })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request('me', 5),
    )

    const paths = pathsOf(pdf)
    expect(result).toEqual({
      path: paths.file,
      fileName: 'example-report.pdf',
      mimeType: 'application/pdf',
      size: PDF_SIZE,
      kind: 'document',
      chatId: SELF_ID,
      messageId: 5,
      uniqueFileId: extractAttachment(pdf)!.uniqueFileId,
      groupedId: null,
      cached: false,
      resumedFrom: null,
      thumb: null,
    })
    expectBytes(readFileSync(paths.file), bytes)
    expect(existsSync(paths.part)).toBe(false)
    expect(existsSync(paths.lock)).toBe(false)

    // Saved Messages: no private-chat check
    expect(telegram.methods()).toEqual([
      'messages.getMessages',
      'upload.getFile',
    ])
    expect(telegram.calls[1]?.options?.floodSleepThreshold).toBe(
      MEDIA_FLOOD_SLEEP_MS,
    )
    expect(transfer.runs).toHaveLength(1)
    expect(transfer.runs[0]?.location).toBeInstanceOf(Document)
    expect(transfer.runs[0]?.params).toMatchObject({
      offset: 0,
      partSize: PART_SIZE_KB,
      fileSize: PDF_SIZE,
      stallTimeout: STALL_TIMEOUT_MS,
    })

    // The fetched message is cached with its attachment row
    expect(createMessagesCache(db).get(SELF_ID, 5)?.message_type).toBe(
      'document',
    )
    expect(createMessageAttachmentsStore(db).get(SELF_ID, 5)).toMatchObject({
      kind: 'document',
      file_name: 'example-report.pdf',
    })
  })

  it('downloads a photo through mtcute Photo', async () => {
    const photo = photoMessage(SELF, 1)
    const telegram = fakeTelegram({ message: () => photo })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(60_000)
    })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request('me', 1),
    )

    expect(result).toMatchObject({ kind: 'photo', size: 60_000, cached: false })
    expect(transfer.runs[0]?.location).toBeInstanceOf(Photo)
  })

  it('asks channels.getMessages for a channel and records its protection', async () => {
    const video = videoMessage(TEAM, 8)
    const telegram = fakeTelegram({
      message: () => video,
      chats: [teamChannel()],
    })
    const transfer = fakeTransfer(async function* () {
      yield* chunksOf(fakeBytes(1_000_000))
    })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request(String(TEAM_CHAT_ID), 8),
    )

    expect(result).toMatchObject({ chatId: TEAM_CHAT_ID, cached: false })
    expect(telegram.calls[0]?.request).toMatchObject({
      _: 'channels.getMessages',
      channel: { _: 'inputChannel', channelId: TEAM_RAW_ID },
      id: [{ _: 'inputMessageID', id: 8 }],
    })
    expect(createChatProtectionStore(db).get(TEAM_CHAT_ID)).toEqual({
      chat_id: TEAM_CHAT_ID,
      protected: 0,
      reason: null,
      fetched_at: NOW,
    })
  })

  it('reports MESSAGE_NOT_FOUND for an empty message or one of another chat', async () => {
    for (const message of [
      { _: 'messageEmpty', id: 5 },
      pdfDocumentMessage(ALICE, 5),
    ]) {
      const telegram = fakeTelegram({ message: () => message })
      const err = await mediaError(
        downloadMedia(
          deps({ getClient: () => telegram.client }),
          request('me', 5),
        ),
      )
      expect(err.code).toBe(ErrorCodes.MESSAGE_NOT_FOUND)
      expect(err.details).toEqual({ chatId: SELF_ID, messageId: 5 })
    }
  })

  it('reports NO_MEDIA for a fetched message without a file', async () => {
    const telegram = fakeTelegram({
      message: () => ({
        _: 'message',
        id: 3,
        peerId: SELF,
        date: 1_760_000_003,
        message: 'Just text',
      }),
    })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client }),
        request('me', 3),
      ),
    )
    expect(err.code).toBe(ErrorCodes.NO_MEDIA)
    expect(err.details).toEqual({
      chatId: SELF_ID,
      messageId: 3,
      messageType: 'text',
    })
  })

  it('fetches the message again with --fresh and serves the cached file', async () => {
    cacheMessage(SELF_ID, pdf)
    place(pathsOf(pdf).file, fakeBytes(PDF_SIZE))
    const telegram = fakeTelegram({ message: () => pdf })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(1)
    })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request('me', 5, { fresh: true }),
    )

    expect(result.cached).toBe(true)
    expect(telegram.methods()).toEqual(['messages.getMessages'])
    expect(transfer.runs).toHaveLength(0)
  })

  it('refuses protected content online and keeps no partial download', async () => {
    const base = pdfDocumentMessage(SELF, 5)
    const cases: Array<{
      chat: string
      chatId: number
      telegram: FakeTelegram
      reason: string
      recorded: ChatProtectionReason | null
    }> = [
      {
        chat: 'me',
        chatId: SELF_ID,
        telegram: { message: () => ({ ...base, noforwards: true }) },
        reason: 'message',
        recorded: null,
      },
      {
        chat: 'me',
        chatId: SELF_ID,
        telegram: {
          message: () => ({
            ...base,
            media: { ...base.media, ttlSeconds: 30 },
          }),
        },
        reason: 'self_destructing',
        recorded: null,
      },
      {
        chat: String(TEAM_CHAT_ID),
        chatId: TEAM_CHAT_ID,
        telegram: {
          message: () => videoMessage(TEAM, 5),
          chats: [teamChannel(true)],
        },
        reason: 'chat',
        recorded: 'chat',
      },
      {
        chat: String(ALICE_ID),
        chatId: ALICE_ID,
        telegram: {
          message: () => pdfDocumentMessage(ALICE, 5),
          fullUser: { noforwardsPeerEnabled: true },
        },
        reason: 'private_chat',
        recorded: 'private_chat',
      },
    ]

    for (const testCase of cases) {
      const telegram = fakeTelegram(testCase.telegram)
      const transfer = fakeTransfer(async function* () {
        yield fakeBytes(1)
      })
      // --fresh: an earlier case cached its protected message
      const err = await mediaError(
        downloadMedia(
          deps({
            getClient: () => telegram.client,
            download: transfer.download,
          }),
          request(testCase.chat, 5, { fresh: true }),
        ),
      )
      expect(err.code).toBe(ErrorCodes.CONTENT_PROTECTED)
      expect(err.details).toEqual({
        chatId: testCase.chatId,
        messageId: 5,
        reason: testCase.reason,
      })
      expect(transfer.runs).toHaveLength(0)
      expect(createChatProtectionStore(db).get(testCase.chatId)?.reason).toBe(
        testCase.recorded ?? undefined,
      )
    }
    expect(existsSync(mediaDir)).toBe(false)
  })

  it('asks for the full user of a private chat only', async () => {
    const message = pdfDocumentMessage(ALICE, 5)
    const telegram = fakeTelegram({ message: () => message, fullUser: {} })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(PDF_SIZE)
    })

    await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request(String(ALICE_ID), 5),
    )

    expect(telegram.methods()).toEqual([
      'messages.getMessages',
      'users.getFullUser',
    ])
    expect(telegram.calls[1]?.request).toMatchObject({
      id: { _: 'inputUser', userId: ALICE_ID },
    })
    expect(createChatProtectionStore(db).get(ALICE_ID)?.protected).toBe(0)
  })
})

describe('downloadMedia: protection found online, then offline', () => {
  const cases = [
    {
      name: 'a group with noforwards',
      chat: String(TEAM_CHAT_ID),
      chatId: TEAM_CHAT_ID,
      message: videoMessage(TEAM, 8),
      size: 1_000_000,
      telegram: (on: boolean) => ({ chats: [teamChannel(on)] }),
      reason: 'chat',
    },
    {
      name: 'a private chat with protection',
      chat: String(ALICE_ID),
      chatId: ALICE_ID,
      message: { ...pdfDocumentMessage(ALICE, 8), id: 8 },
      size: PDF_SIZE,
      telegram: (on: boolean) => ({
        fullUser: { noforwardsMyEnabled: on },
      }),
      reason: 'private_chat',
    },
  ]

  for (const testCase of cases) {
    it(`refuses the cached file of ${testCase.name} until a check finds it off`, async () => {
      cacheMessage(testCase.chatId, testCase.message)
      const { file } = pathsOf(testCase.message)
      place(file, fakeBytes(testCase.size))

      const protectedTelegram = fakeTelegram({
        message: () => testCase.message,
        ...testCase.telegram(true),
      })
      const online = await mediaError(
        downloadMedia(
          deps({ getClient: () => protectedTelegram.client }),
          request(testCase.chat, 8, { fresh: true }),
        ),
      )
      expect(online.details).toMatchObject({ reason: testCase.reason })
      expect(createChatProtectionStore(db).get(testCase.chatId)).toMatchObject({
        protected: 1,
        reason: testCase.reason,
      })

      // Offline: no client, the file stays where it is
      const offline = await mediaError(
        downloadMedia(deps(), request(testCase.chat, 8)),
      )
      expect(offline.code).toBe(ErrorCodes.CONTENT_PROTECTED)
      expect(offline.details).toMatchObject({ reason: testCase.reason })
      expect(existsSync(file)).toBe(true)

      const openTelegram = fakeTelegram({
        message: () => testCase.message,
        ...testCase.telegram(false),
      })
      const fresh = await downloadMedia(
        deps({ getClient: () => openTelegram.client }),
        request(testCase.chat, 8, { fresh: true }),
      )
      expect(fresh.cached).toBe(true)
      expect(
        createChatProtectionStore(db).get(testCase.chatId)?.protected,
      ).toBe(0)

      const again = await downloadMedia(deps(), request(testCase.chat, 8))
      expect(again).toMatchObject({ cached: true, path: file })
    })
  }

  it('serves the file offline after --fresh finds an old raw chat flag off', async () => {
    const video = videoMessage(TEAM, 8)
    cacheMessage(TEAM_CHAT_ID, video)
    const { file } = pathsOf(video)
    place(file, fakeBytes(1_000_000))
    db.query(
      'UPDATE chats_cache SET raw_json = ?, fetched_at = ? WHERE chat_id = ?',
    ).run(JSON.stringify(teamChannel(true)), NOW - 60_000, String(TEAM_CHAT_ID))

    const before = await mediaError(
      downloadMedia(deps(), request(String(TEAM_CHAT_ID), 8)),
    )
    expect(before.details).toMatchObject({ reason: 'chat' })

    const telegram = fakeTelegram({
      message: () => video,
      chats: [teamChannel(false)],
    })
    const fresh = await downloadMedia(
      deps({ getClient: () => telegram.client }),
      request(String(TEAM_CHAT_ID), 8, { fresh: true }),
    )
    expect(fresh.cached).toBe(true)

    const offline = await downloadMedia(
      deps(),
      request(String(TEAM_CHAT_ID), 8),
    )
    expect(offline).toMatchObject({ cached: true, path: file })
  })

  const noChatObject = [
    { name: 'no chat object', chats: [] },
    {
      name: 'a forbidden channel',
      chats: [
        {
          _: 'channelForbidden',
          id: TEAM_RAW_ID,
          accessHash: Long.fromString('7000000000000000005'),
          title: 'Example Team',
        },
      ],
    },
  ]
  for (const answer of noChatObject) {
    it(`keeps a known protection when --fresh gets ${answer.name}`, async () => {
      const video = videoMessage(TEAM, 8)
      cacheMessage(TEAM_CHAT_ID, video)
      createChatProtectionStore(db).record(
        TEAM_CHAT_ID,
        { protected: true, reason: 'chat' },
        NOW - 60_000,
      )
      const telegram = fakeTelegram({
        message: () => video,
        chats: answer.chats,
      })
      const transfer = fakeTransfer(async function* () {
        yield fakeBytes(1_000_000)
      })

      const err = await mediaError(
        downloadMedia(
          deps({
            getClient: () => telegram.client,
            download: transfer.download,
          }),
          request(String(TEAM_CHAT_ID), 8, { fresh: true }),
        ),
      )
      expect(err.code).toBe(ErrorCodes.CONTENT_PROTECTED)
      expect(err.details).toMatchObject({ reason: 'chat' })
      expect(transfer.runs).toHaveLength(0)
      expect(existsSync(pathsOf(video).part)).toBe(false)
      expect(createChatProtectionStore(db).get(TEAM_CHAT_ID)).toMatchObject({
        protected: 1,
        fetched_at: NOW - 60_000,
      })
    })
  }

  it('refuses the next offline run after --fresh finds a message protected', async () => {
    cacheMessage(SELF_ID, pdf)
    place(pathsOf(pdf).file, fakeBytes(PDF_SIZE))
    const telegram = fakeTelegram({
      message: () => ({ ...pdf, noforwards: true }),
    })

    await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client }),
        request('me', 5, { fresh: true }),
      ),
    )
    const offline = await mediaError(downloadMedia(deps(), request('me', 5)))
    expect(offline.details).toMatchObject({ reason: 'message' })
  })
})

describe('downloadMedia: partial downloads', () => {
  it('resumes from the last whole part of a partial download', async () => {
    const video = videoMessage(SELF, 9)
    const paths = pathsOf(video)
    const kept = fakeBytes(700_000, 1)
    place(paths.part, kept)
    const rest = fakeBytes(1_000_000 - PART_BYTES, 9)
    let partAtStart = -1
    const transfer = fakeTransfer(async function* () {
      partAtStart = statSync(paths.part).size
      yield* chunksOf(rest)
    })
    const telegram = fakeTelegram({ message: () => video })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request('me', 9),
    )

    expect(transfer.runs[0]?.params.offset).toBe(PART_BYTES)
    expect(partAtStart).toBe(PART_BYTES)
    expect(result).toMatchObject({
      cached: false,
      resumedFrom: PART_BYTES,
      size: 1_000_000,
    })
    const saved = readFileSync(paths.file)
    expectBytes(saved.subarray(0, PART_BYTES), kept.subarray(0, PART_BYTES))
    expectBytes(saved.subarray(PART_BYTES), rest)
  })

  it('starts over when the partial download is larger than the file', async () => {
    const video = videoMessage(SELF, 9)
    const paths = pathsOf(video)
    place(paths.part, fakeBytes(1_200_000))
    const transfer = fakeTransfer(async function* () {
      yield* chunksOf(fakeBytes(1_000_000))
    })
    const telegram = fakeTelegram({ message: () => video })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request('me', 9),
    )

    expect(transfer.runs[0]?.params.offset).toBe(0)
    expect(result.resumedFrom).toBeNull()
    expect(statSync(paths.file).size).toBe(1_000_000)
  })

  it('ends a stalled download with NETWORK_ERROR and keeps the partial download', async () => {
    const paths = pathsOf(pdf)
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(65_536)
      throw new MtTimeoutError(STALL_TIMEOUT_MS)
    })
    const telegram = fakeTelegram({ message: () => pdf })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client, download: transfer.download }),
        request('me', 5),
      ),
    )

    expect(err.code).toBe(ErrorCodes.NETWORK_ERROR)
    expect(err.details).toEqual({
      stalled_seconds: 60,
      downloaded_bytes: 65_536,
      resumable: true,
    })
    expect(statSync(paths.part).size).toBe(65_536)
    expect(existsSync(paths.lock)).toBe(false)
  })

  it('keeps the partial download when interrupted', async () => {
    const paths = pathsOf(pdf)
    const controller = new AbortController()
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(65_536)
      controller.abort()
      throw controller.signal.reason
    })
    const telegram = fakeTelegram({ message: () => pdf })

    const err = await downloadMedia(
      deps({
        getClient: () => telegram.client,
        download: transfer.download,
        signal: controller.signal,
      }),
      request('me', 5),
    ).catch((reason: unknown) => reason)

    expect(err).toBeInstanceOf(DownloadInterruptedError)
    expect(err).toMatchObject({ downloaded: 65_536, total: PDF_SIZE })
    expect(statSync(paths.part).size).toBe(65_536)
    expect(existsSync(paths.lock)).toBe(false)
  })

  it('reports a CDN file as MEDIA_UNSUPPORTED and drops the partial download', async () => {
    const paths = pathsOf(pdf)
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(65_536)
      throw new MtUnsupportedError(
        'Received CDN redirect, which is not supported (yet)',
      )
    })
    const telegram = fakeTelegram({ message: () => pdf })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client, download: transfer.download }),
        request('me', 5),
      ),
    )

    expect(err.code).toBe(ErrorCodes.MEDIA_UNSUPPORTED)
    expect(err.details).toEqual({ reason: 'cdn' })
    expect(existsSync(paths.part)).toBe(false)
  })

  it('drops a download that ends short with NETWORK_ERROR', async () => {
    const paths = pathsOf(pdf)
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(100)
    })
    const telegram = fakeTelegram({ message: () => pdf })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client, download: transfer.download }),
        request('me', 5),
      ),
    )

    expect(err.code).toBe(ErrorCodes.NETWORK_ERROR)
    expect(err.details).toEqual({ expected: PDF_SIZE, received: 100 })
    expect(existsSync(paths.part)).toBe(false)
    expect(existsSync(paths.file)).toBe(false)
  })
})

describe('downloadMedia: Telegram errors during the transfer', () => {
  it('fetches the message again once for an expired file reference', async () => {
    const telegram = fakeTelegram({ message: () => pdf })
    const transfer = fakeTransfer(async function* (_run, index) {
      if (index === 0) throw new tl.RpcError(400, 'FILE_REFERENCE_EXPIRED')
      yield fakeBytes(PDF_SIZE)
    })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request('me', 5),
    )

    expect(result.cached).toBe(false)
    expect(transfer.runs).toHaveLength(2)
    expect(
      telegram.methods().filter((method) => method === 'messages.getMessages'),
    ).toHaveLength(2)
  })

  it('reports a file reference rejected twice as TELEGRAM_ERROR', async () => {
    const telegram = fakeTelegram({ message: () => pdf })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(0)
      throw new tl.RpcError(400, 'FILE_REFERENCE_EXPIRED')
    })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client, download: transfer.download }),
        request('me', 5),
      ),
    )
    expect(err.code).toBe(ErrorCodes.TELEGRAM_ERROR)
    expect(transfer.runs).toHaveLength(2)
  })

  it('records a flood wait the rate-limit wrapper could not read', async () => {
    const telegram = fakeTelegram({ message: () => pdf })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(0)
      throw new tl.RpcError(420, 'FLOOD_PREMIUM_WAIT_7')
    })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client, download: transfer.download }),
        request('me', 5),
      ),
    )
    expect(err.code).toBe(ErrorCodes.RATE_LIMITED)
    expect(err.details).toEqual({ method: 'upload.getFile', wait_seconds: 7 })
    expect(createRateLimitsService(db).isBlocked('upload.getFile')).toBe(true)
  })

  it('reports a recorded flood wait as RATE_LIMITED', async () => {
    const telegram = fakeTelegram({ message: () => pdf })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(0)
      throw new RateLimitError('upload.getFile', 30)
    })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client, download: transfer.download }),
        request('me', 5),
      ),
    )
    expect(err.code).toBe(ErrorCodes.RATE_LIMITED)
    expect(err.details).toEqual({ method: 'upload.getFile', wait_seconds: 30 })
  })

  it('reports another refusal as TELEGRAM_ERROR', async () => {
    const telegram = fakeTelegram({ message: () => pdf })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(0)
      throw new tl.RpcError(400, 'LOCATION_INVALID')
    })

    const err = await mediaError(
      downloadMedia(
        deps({ getClient: () => telegram.client, download: transfer.download }),
        request('me', 5),
      ),
    )
    expect(err.code).toBe(ErrorCodes.TELEGRAM_ERROR)
    expect(err.details).toMatchObject({ error: 'LOCATION_INVALID' })
  })
})

describe('downloadMedia --thumb from Telegram', () => {
  it("downloads a document's preview with the preview's own size", async () => {
    const video = documentMessage(SELF, 10, {
      id: '6000000000000000031',
      mimeType: 'video/mp4',
      size: 4_000_000,
      attributes: [
        { _: 'documentAttributeVideo', duration: 30, w: 1920, h: 1080 },
      ],
    })
    const telegram = fakeTelegram({ message: () => video })
    const transfer = fakeTransfer(async function* () {
      yield fakeBytes(3_000, 2)
    })

    const result = await downloadMedia(
      deps({ getClient: () => telegram.client, download: transfer.download }),
      request('me', 10, { thumb: true }),
    )

    const info = extractAttachment(video)!
    const thumb = pickThumb(video)!
    const { file } = thumbPaths(mediaDir, info, thumb)
    expect(transfer.runs[0]?.params.fileSize).toBe(3_000)
    expect(transfer.runs[0]?.location).toBeInstanceOf(Thumbnail)
    expect(result).toEqual({
      path: file,
      fileName: 'thumb-m.jpg',
      mimeType: 'image/jpeg',
      size: 3_000,
      kind: 'thumbnail',
      chatId: SELF_ID,
      messageId: 10,
      uniqueFileId: thumb.uniqueFileId,
      groupedId: null,
      cached: false,
      resumedFrom: null,
      thumb: { type: 'm', width: 320, height: 180 },
    })
    expect(statSync(file).size).toBe(3_000)

    const again = await downloadMedia(
      deps(),
      request('me', 10, { thumb: true }),
    )
    expect(again).toMatchObject({ cached: true, size: 3_000, path: file })
  })
})

describe('fetchMessageById', () => {
  it('asks messages.getMessages for a private chat', async () => {
    const telegram = fakeTelegram({ message: () => pdf })
    const fetched = await fetchMessageById(
      telegram.client,
      { chatId: SELF_ID, inputPeer: { _: 'inputPeerSelf' } },
      5,
    )
    expect(fetched.message.id).toBe(5)
    expect(telegram.calls[0]?.request).toEqual({
      _: 'messages.getMessages',
      id: [{ _: 'inputMessageID', id: 5 }],
    })
  })
})
