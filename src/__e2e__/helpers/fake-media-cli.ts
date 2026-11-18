/**
 * Runs the tg CLI with a fake Telegram client that serves made-up documents,
 * for the `tg media download` e2e tests. Pass it as `entry` to runCli and
 * the documents in FAKE_MEDIA_ENV (JSON of FakeMediaScenario).
 *
 * messages.getMessages returns the documents' messages, users.getFullUser
 * an unprotected private chat, and upload.getFile each document's bytes
 * (`mediaBytes`). Every call is printed to stderr after FAKE_MEDIA_CALL, so
 * a test can count them.
 */
import type { tl as Tl } from '@mtcute/bun'

import { documentMessage } from '../../__tests__/helpers/media-messages'
import { fakeBytes } from '../../__tests__/helpers/photo-message'

export const FAKE_MEDIA_CLI = import.meta.path
export const FAKE_MEDIA_ENV = 'TG_FAKE_MEDIA'
export const FAKE_MEDIA_CALL = 'fake media: call'

export interface FakeMediaFile {
  /** Message ID */
  id: number
  size: number
  fileName: string
  /** upload.getFile fails with this RPC error */
  error?: string
  /** The first upload.getFile fails with FLOOD_WAIT of this many seconds */
  floodWaitOnce?: number
}

export interface FakeMediaScenario {
  /** The private chat (user ID) the messages are in */
  userId: number
  tty?: boolean
  files: FakeMediaFile[]
}

/** Each document's ID, as a decimal string: 6000000000000000100 + message ID */
export function mediaDocumentId(messageId: number): string {
  return String(6_000_000_000_000_000_100n + BigInt(messageId))
}

/** The made-up bytes of a document */
export function mediaBytes(file: FakeMediaFile): Uint8Array {
  return fakeBytes(file.size, file.id)
}

/** The message of a document, as Telegram sends it */
export function mediaMessage(userId: number, file: FakeMediaFile) {
  return documentMessage({ _: 'peerUser', userId }, file.id, {
    id: mediaDocumentId(file.id),
    mimeType: 'application/octet-stream',
    size: file.size,
    thumbs: [],
    attributes: [{ _: 'documentAttributeFilename', fileName: file.fileName }],
  })
}

if (import.meta.main) {
  const { mock } = await import('bun:test')
  const { tl } = await import('@mtcute/bun')
  const telegram = await import('../../services/telegram')
  const scenario = JSON.parse(
    process.env[FAKE_MEDIA_ENV] ?? '{}',
  ) as FakeMediaScenario
  if (scenario.tty)
    Object.defineProperty(process.stderr, 'isTTY', { value: true })
  const byDocument = new Map(
    scenario.files.map((file) => [mediaDocumentId(file.id), file]),
  )
  const flooded = new Set<number>()
  const log = (entry: Record<string, unknown>) =>
    console.error(`${FAKE_MEDIA_CALL} ${JSON.stringify(entry)}`)

  const client = {
    log: { debug() {}, warn() {} },
    async getPrimaryDcId() {
      return 2
    },
    getPoolSize() {
      return 1
    },
    async call(request: { _: string } & Record<string, unknown>) {
      switch (request._) {
        case 'messages.getMessages': {
          const ids = (request.id as { id: number }[]).map((item) => item.id)
          log({ method: request._, ids })
          return {
            _: 'messages.messages',
            messages: scenario.files
              .filter((file) => ids.includes(file.id))
              .map((file) => mediaMessage(scenario.userId, file)),
            topics: [],
            chats: [],
            users: [],
          }
        }
        case 'users.getFullUser':
          log({ method: request._ })
          return {
            _: 'users.userFull',
            fullUser: { _: 'userFull', id: scenario.userId },
            chats: [],
            users: [],
          }
        case 'upload.getFile': {
          const location = request.location as { id: { toString(): string } }
          const file = byDocument.get(location.id.toString())
          const offset = request.offset as number
          const limit = request.limit as number
          log({ method: request._, id: file?.id, offset })
          if (!file) throw new tl.RpcError(400, 'FILE_ID_INVALID')
          if (file.error) throw new tl.RpcError(400, file.error)
          if (file.floodWaitOnce && !flooded.has(file.id)) {
            flooded.add(file.id)
            throw new tl.RpcError(420, `FLOOD_WAIT_${file.floodWaitOnce}`)
          }
          return {
            _: 'upload.file',
            type: { _: 'storage.fileUnknown' },
            mtime: 0,
            bytes: mediaBytes(file).subarray(offset, offset + limit),
          } satisfies Tl.upload.RawFile
        }
        default:
          throw new tl.RpcError(400, 'METHOD_INVALID')
      }
    },
    async destroy() {},
  }

  mock.module('../../services/telegram', () => ({
    ...telegram,
    getClientForAccount: () => client,
  }))

  await import('../../index')
}
