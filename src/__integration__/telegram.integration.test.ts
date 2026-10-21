/**
 * Live smoke tests against the real Telegram API.
 *
 * Each test runs the CLI the way a user would, in an isolated data dir that
 * holds a copy of a pre-authenticated session. Messages go only to the test
 * account's own Saved Messages and are deleted afterwards.
 */

import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  type CliOptions,
  runCli,
  runCliSuccess,
  spawnCli,
} from '../__e2e__/helpers/cli'
import { VERSION } from '../version'
import {
  createIntegrationEnvironment,
  type IntegrationEnvironment,
} from './helpers/setup'

const TEST_ACCOUNT = process.env.TELEGRAM_TEST_ACCOUNT
const TEST_SESSION_PATH =
  process.env.TELEGRAM_TEST_SESSION_PATH ?? process.env.TELEGRAM_TEST_SESSION
// test-setup.ts replaces TELEGRAM_API_* with dummies and stashes the real
// values under TELEGRAM_TEST_API_*
const API_ID = process.env.TELEGRAM_TEST_API_ID
const API_HASH = process.env.TELEGRAM_TEST_API_HASH
const SHOULD_RUN = Boolean(
  TEST_ACCOUNT && TEST_SESSION_PATH && API_ID && API_HASH,
)
// The daemon needs a live connection; fixtures can't replay real-time updates
const CAN_RUN_DAEMON = SHOULD_RUN && process.env.TELEGRAM_API_REPLAY !== '1'

const API_TIMEOUT_MS = 30_000
const DAEMON_TEST_TIMEOUT_MS = 420_000

type Envelope<T> = { success: boolean; data: T }

function uniqueMarker(): string {
  return `tgsmoke${Date.now()}${Math.random().toString(36).slice(2, 8)}`
}

/** Keep draining a stream so a chatty child never blocks on a full pipe */
function collectOutput(stream: ReadableStream<Uint8Array>) {
  let text = ''
  const decoder = new TextDecoder()
  const done = (async () => {
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true })
    }
  })()
  return {
    /** Resolves once the stream has closed */
    done,
    get text() {
      return text
    },
  }
}

async function waitFor<T>(
  check: () => Promise<T | null>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== null) return value
    await Bun.sleep(1000)
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`)
}

describe.skipIf(!SHOULD_RUN)('Smoke: tg against the real Telegram API', () => {
  let env: IntegrationEnvironment
  const sentMessageIds: number[] = []

  function cli(timeout = API_TIMEOUT_MS): CliOptions {
    return {
      ...env.getCliOptions({
        TELEGRAM_API_ID: API_ID!,
        TELEGRAM_API_HASH: API_HASH!,
      }),
      timeout,
    }
  }

  async function sendToSavedMessages(text: string): Promise<number> {
    const result = await runCliSuccess(
      ['send', '--to', 'me', '--message', text, '--silent'],
      cli(),
    )
    const payload = result.json as Envelope<{
      sent: boolean
      messageId: number
    }>
    expect(payload.data.sent).toBe(true)
    expect(typeof payload.data.messageId).toBe('number')
    sentMessageIds.push(payload.data.messageId)
    return payload.data.messageId
  }

  beforeEach(async () => {
    env = createIntegrationEnvironment('smoke')
    await env.initFromSession({
      phone: TEST_ACCOUNT!,
      sessionPath: TEST_SESSION_PATH!,
    })
  })

  afterEach(async () => {
    if (sentMessageIds.length > 0) {
      const ids = sentMessageIds.splice(0)
      await runCli(
        [
          'api',
          'messages.deleteMessages',
          '--json',
          JSON.stringify({ id: ids, revoke: true }),
        ],
        cli(),
      )
    }
    env.cleanup()
  })

  it(
    'auth status and me confirm the session and cache the profile',
    async () => {
      const status = await runCliSuccess(['auth', 'status'], cli())
      expect(status.json).toMatchObject({
        success: true,
        data: { authenticated: true, account: { phone: TEST_ACCOUNT } },
      })

      const fresh = await runCliSuccess(['me', '--fresh'], cli())
      const freshUser = (fresh.json as Envelope<{ user: { id: number } }>).data
        .user
      expect(typeof freshUser.id).toBe('number')

      const cached = await runCliSuccess(['me'], cli())
      expect(
        (cached.json as Envelope<{ user: { id: number } }>).data.user.id,
      ).toBe(freshUser.id)
    },
    API_TIMEOUT_MS * 3,
  )

  it(
    'chats and contacts are fetched from the API and served from the cache',
    async () => {
      const fresh = await runCliSuccess(
        ['chats', 'list', '--fresh', '--limit', '5'],
        cli(),
      )
      const freshChats = fresh.json as Envelope<{
        items: unknown[]
        total: number
      }>
      expect(freshChats.data.items.length).toBeGreaterThan(0)

      const cached = await runCliSuccess(
        ['chats', 'list', '--limit', '5'],
        cli(),
      )
      expect(cached.json).toMatchObject({
        success: true,
        data: { source: 'cache' },
      })

      const contacts = await runCliSuccess(
        ['contacts', 'list', '--fresh', '--limit', '1'],
        cli(),
      )
      expect(contacts.json).toMatchObject({
        success: true,
        data: { source: 'api' },
      })
    },
    API_TIMEOUT_MS * 3,
  )

  it(
    'send to Saved Messages round-trips through the raw API',
    async () => {
      const marker = uniqueMarker()
      const messageId = await sendToSavedMessages(`tg smoke test ${marker}`)

      const result = await runCliSuccess(
        [
          'api',
          'messages.getMessages',
          '--json',
          JSON.stringify({ id: [{ _: 'inputMessageID', id: messageId }] }),
        ],
        cli(),
      )
      const payload = result.json as Envelope<{
        result: { messages: Array<{ id: number; message?: string }> }
      }>
      const message = payload.data.result.messages.find(
        (m) => m.id === messageId,
      )
      expect(message?.message).toContain(marker)
    },
    API_TIMEOUT_MS * 3,
  )

  it(
    'send to Saved Messages caches the message for search without a daemon',
    async () => {
      const marker = uniqueMarker()
      const messageId = await sendToSavedMessages(`tg smoke test ${marker}`)

      const result = await runCliSuccess(
        ['messages', 'search', '--query', marker],
        cli(),
      )
      const payload = result.json as Envelope<{
        results: Array<{
          chatId: number
          messageId: number
          text: string
        }>
      }>
      expect(payload.data.results).toHaveLength(1)
      expect(payload.data.results[0]?.text).toContain(marker)

      // Saved Messages is cached under the own user ID, like the daemon does
      const me = await runCliSuccess(['me'], cli())
      const userId = (me.json as Envelope<{ user: { id: number } }>).data.user
        .id
      expect(payload.data.results[0]).toMatchObject({
        chatId: userId,
        messageId,
      })
    },
    API_TIMEOUT_MS * 3,
  )

  it(
    'messages list and get read Saved Messages from Telegram, then from the cache',
    async () => {
      type Item = { chatId: number; messageId: number; text: string | null }
      type ListData = { chatId: number; items: Item[]; source: string }
      type GetData = {
        message: Item
        newer: Item[]
        older: Item[]
        source: string
      }
      const list = async (...args: string[]) =>
        (
          (
            await runCliSuccess(
              ['messages', 'list', '--chat', 'me', ...args],
              cli(),
            )
          ).json as Envelope<ListData>
        ).data
      const get = async (...args: string[]) =>
        (
          (
            await runCliSuccess(
              ['messages', 'get', '--chat', 'me', ...args],
              cli(),
            )
          ).json as Envelope<GetData>
        ).data

      const markerA = uniqueMarker()
      const markerB = uniqueMarker()
      const idA = await sendToSavedMessages(`tg smoke test ${markerA}`)
      const idB = await sendToSavedMessages(`tg smoke test ${markerB}`)

      // tg send caches what it sends; drop that so the read has to fetch
      const cacheDb = new Database(join(env.dataDir, 'cache.db'))
      cacheDb.run('DELETE FROM messages_cache WHERE message_id IN (?, ?)', [
        idA,
        idB,
      ])
      cacheDb.close()

      const fresh = await list('--fresh', '--limit', '5')
      const me = await runCliSuccess(['me'], cli())
      const userId = (me.json as Envelope<{ user: { id: number } }>).data.user
        .id
      expect(fresh.source).toBe('api')
      expect(fresh.chatId).toBe(userId)
      expect(fresh.items.slice(0, 2).map((item) => item.messageId)).toEqual([
        idB,
        idA,
      ])
      expect(fresh.items[1]?.text).toContain(markerA)

      const cached = await list('--limit', '5')
      expect(cached.source).toBe('cache')
      expect(cached.items.slice(0, 2)).toEqual(fresh.items.slice(0, 2))

      const search = await runCliSuccess(
        ['messages', 'search', '--query', markerA],
        cli(),
      )
      expect(
        (search.json as Envelope<{ results: Item[] }>).data.results.map(
          (item) => item.messageId,
        ),
      ).toEqual([idA])

      const after = await list('--after', String(idA), '--fresh')
      expect(after.items.map((item) => item.messageId)).toEqual([idB])

      const around = await get('--id', String(idA), '--context', '1', '--fresh')
      expect(around.source).toBe('api')
      expect(around.message.messageId).toBe(idA)
      expect(around.newer[0]?.messageId).toBe(idB)

      const fromCache = await get('--id', String(idA))
      expect(fromCache.source).toBe('cache')
      expect(fromCache.message).toEqual(around.message)

      // Cache-first with a wider context: the newer side of the newest
      // message may still ask Telegram, so only the items are pinned
      const wide = await get('--id', String(idA), '--context', '2')
      expect(wide.message).toEqual(around.message)
      expect(wide.message.text).toContain(markerA)
      expect(wide.newer.map((item) => item.messageId)).toEqual([idB])
      expect(wide.older.length).toBeLessThanOrEqual(2)
      expect(
        wide.older.every(
          (item) => item.messageId < idA && item.chatId === userId,
        ),
      ).toBe(true)
    },
    API_TIMEOUT_MS * 6,
  )

  it.skipIf(!CAN_RUN_DAEMON)(
    'daemon connects, bootstraps dialogs, syncs history and stops cleanly',
    async () => {
      const daemon = spawnCli(['daemon', 'start'], cli())
      const logs = collectOutput(daemon.stdout)
      const errors = collectOutput(daemon.stderr)

      try {
        await waitFor(
          async () =>
            logs.text.includes('Real-time updates active') ? true : null,
          60_000,
          'the daemon to start real-time updates',
        )

        // Bootstrap waits out FLOOD_WAITs on messages.getDialogs
        await waitFor(
          async () =>
            /Bootstrapped \d+ dialogs/.test(logs.text) ? true : null,
          150_000,
          'the dialog bootstrap',
        )

        // Real dialogs land under marked IDs (#18). Read the file directly:
        // every CLI open re-keys bare rows first, so tg sql would hide them.
        const cacheFile = new Database(join(env.dataDir, 'cache.db'), {
          readonly: true,
        })
        try {
          expect(
            cacheFile
              .query(
                "SELECT chat_id, type FROM chats_cache WHERE type <> 'private' AND CAST(chat_id AS INTEGER) > 0",
              )
              .all(),
          ).toEqual([])
          expect(
            cacheFile
              .query(`
                SELECT s.chat_id, s.chat_type FROM chat_sync_state s
                WHERE s.chat_type <> 'private'
                  AND NOT EXISTS (
                    SELECT 1 FROM chats_cache c
                    WHERE c.chat_id = CAST(s.chat_id AS TEXT)
                  )
              `)
              .all(),
          ).toEqual([])
        } finally {
          cacheFile.close()
        }

        const chats = await runCliSuccess(
          ['chats', 'list', '--limit', '1'],
          cli(),
        )
        const cachedChats = chats.json as Envelope<{
          source: string
          total: number
        }>
        expect(cachedChats.data.source).toBe('cache')
        expect(cachedChats.data.total).toBeGreaterThan(0)

        await waitFor(
          async () => {
            const result = await runCli(
              ['sql', '--query', 'SELECT COUNT(*) AS n FROM messages_cache'],
              cli(),
            )
            const payload = result.json as Envelope<{
              rows: Array<{ n: number }>
            }>
            const count = payload?.data?.rows?.[0]?.n ?? 0
            return count > 0 ? count : null
          },
          60_000,
          'sync jobs to cache messages',
        )

        // First pages run next to catch-up instead of waiting behind it (#6)
        await waitFor(
          async () => {
            const result = await runCli(
              [
                'sql',
                '--query',
                "SELECT COUNT(*) AS n FROM sync_jobs WHERE job_type = 'initial_load' AND status = 'completed'",
              ],
              cli(),
            )
            const payload = result.json as Envelope<{
              rows: Array<{ n: number }>
            }>
            const count = payload?.data?.rows?.[0]?.n ?? 0
            return count > 0 ? count : null
          },
          90_000,
          'a completed initial_load job',
        )

        const status = await runCliSuccess(['status'], cli())
        expect(status.json).toMatchObject({
          success: true,
          data: {
            daemon: {
              status: 'running',
              version: VERSION,
              version_mismatch: false,
            },
            sync: { failed_jobs: expect.any(Number) },
            cli_version: VERSION,
          },
        })

        const stop = await runCliSuccess(['daemon', 'stop'], cli())
        expect(stop.json).toMatchObject({ success: true })
        expect(await daemon.exited).toBe(0)
        // A normal stop logs no close warning, although mtcute has already
        // closed the session files when the signal arrived (#34)
        await errors.done
        expect(errors.text).not.toContain('Failed to close client')
      } finally {
        daemon.kill()
      }
    },
    DAEMON_TEST_TIMEOUT_MS,
  )
})
