/**
 * E2E tests for read-only mode and the chat allowlist. The write and the
 * chat-scoped commands are enumerated from the command tree, so a new
 * command is covered as soon as COMMAND_ACCESS classifies it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { takePartIn } from '../__tests__/helpers/participation'
import { main } from '../cli'
import { COMMAND_ACCESS, runnableCommands } from '../commands/access'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createChatsCache } from '../db/chats-cache'
import { createDaemonStatusService } from '../db/daemon-status'
import { createMessagesCache } from '../db/messages-cache'
import { createUsersCache } from '../db/users-cache'
import { toPeerIdFromRawPeer } from '../utils/telegram-peer-ids'
import {
  type CliOptions,
  NO_CREDENTIALS,
  runCli,
  runCliSuccess,
  spawnCli,
} from './helpers/cli'
import { FAKE_CLIENT_CLI } from './helpers/fake-client-cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const SELF_ID = 999
const TEAM_ID = -1001234567890
const CLUB_ID = -4242
const ALICE_ID = 10

const TEAM_PEER = { _: 'peerChannel', channelId: 1234567890 } as const
const CLUB_PEER = { _: 'peerChat', chatId: 4242 } as const
const ALICE_PEER = { _: 'peerUser', userId: ALICE_ID } as const

function message(
  peer: typeof TEAM_PEER | typeof CLUB_PEER | typeof ALICE_PEER,
  id: number,
  text: string,
) {
  return parseRawMessage(
    {
      _: 'message',
      id,
      peerId: peer,
      message: text,
      date: Math.floor(Date.now() / 1000) - 3600 + id * 60,
    },
    toPeerIdFromRawPeer(peer)!,
  )!
}

/** Every chat's one cached message is unread */
const UNREAD = { unreadCount: 1, readInboxMaxId: 0 }

interface CommandArg {
  type?: string
  required?: boolean
}

/**
 * The argv of a command, with a made-up value for each required arg and
 * `chat` for the chat args: enough to reach the checks, which run before
 * the command reads any value
 */
function argv(path: string, chat?: string): string[] {
  const node = runnableCommands(main).find((c) => c.path === path)?.node as {
    args?: Record<string, CommandArg>
  }
  const chatArgs = COMMAND_ACCESS[path]?.chatArgs ?? []
  const out = path.split(' ')
  for (const [name, def] of Object.entries(node.args ?? {})) {
    const value =
      chat !== undefined && chatArgs.includes(name)
        ? chat
        : def.required
          ? '1'
          : undefined
    if (value === undefined) continue
    out.push(...(def.type === 'positional' ? [value] : [`--${name}`, value]))
  }
  return out
}

const PATHS = runnableCommands(main).map(({ path }) => path)

interface ErrorJson {
  success: false
  error: { code: string; details?: Record<string, unknown> }
}

describe('E2E: read-only mode and allowedChats', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTestEnvironment('access')
    env.initDatabase()
    env.seedAccounts([
      { phone: '+15550000000', user_id: SELF_ID, is_active: true },
    ])
    const db = env.openCacheDb(1)
    createUsersCache(db).upsert({
      user_id: String(ALICE_ID),
      username: 'alice',
      first_name: 'Alice',
      access_hash: '777',
      fetched_at: Date.now(),
      raw_json: '{}',
    })
    createChatsCache(db).upsertMany(
      [
        fakeDialog({
          kind: 'supergroup',
          id: 1234567890,
          title: 'Team Chat',
          username: 'teamchat',
          membersCount: 3,
          ...UNREAD,
        }),
        fakeDialog({ kind: 'group', id: 4242, title: 'Book Club', ...UNREAD }),
        fakeDialog({
          kind: 'user',
          id: ALICE_ID,
          title: 'Alice Able',
          ...UNREAD,
        }),
      ].map(dialogToCacheInput),
    )
    takePartIn(db, TEAM_ID, CLUB_ID)
    createMessagesCache(db).upsertBatch([
      message(TEAM_PEER, 1, 'hello team'),
      message(CLUB_PEER, 2, 'hello club'),
      message(ALICE_PEER, 3, 'hello from Alice'),
    ])
  })

  afterAll(() => {
    env.cleanup()
  })

  function options(vars: Record<string, string> = {}): CliOptions {
    return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS, ...vars } }
  }

  async function refusal(args: string[], vars: Record<string, string>) {
    const result = await runCli(args, options(vars))
    return { exitCode: result.exitCode, json: result.json as ErrorJson }
  }

  describe('read-only', () => {
    const READ_ONLY = { TELEGRAM_SYNC_CLI_READ_ONLY: '1' }
    const writes = PATHS.filter((path) => COMMAND_ACCESS[path]?.write === true)

    it('enumerates the write commands from the tree', () => {
      expect(writes).toEqual(
        expect.arrayContaining([
          'send',
          'messages read',
          'messages pin',
          'messages unpin',
          'auth logout',
          'auth login',
        ]),
      )
    })

    for (const path of writes) {
      it(`refuses tg ${path} before connecting, with exit 1`, async () => {
        const { exitCode, json } = await refusal(argv(path), READ_ONLY)
        expect(json.error.code).toBe('READ_ONLY')
        expect(json.error.details).toEqual({ command: path })
        expect(exitCode).toBe(1)
      })
    }

    it('refuses a tg api method that is not a read', async () => {
      const { json } = await refusal(
        ['api', 'messages.readHistory', '--peer', 'me'],
        READ_ONLY,
      )
      expect(json.error).toMatchObject({
        code: 'READ_ONLY',
        details: { command: 'api', method: 'messages.readHistory' },
      })
    })

    it('runs a tg api read method', async () => {
      const result = await runCli(['api', 'help.getConfig'], {
        ...options(READ_ONLY),
        entry: FAKE_CLIENT_CLI,
      })
      expect(result.exitCode).toBe(0)
    })

    it('runs cache reads, and readOnly in config.json turns it on too', async () => {
      await runCliSuccess(['chats', 'list'], options(READ_ONLY))
      await runCliSuccess(
        ['messages', 'search', '--query', 'hello'],
        options(READ_ONLY),
      )
      await Bun.write(
        `${env.dataDir}/config.json`,
        JSON.stringify({ readOnly: true }),
      )
      try {
        const { json } = await refusal(['send', '--to', 'me', '-m', 'hi'], {})
        expect(json.error.code).toBe('READ_ONLY')
        const status = await runCliSuccess(['status'], options())
        expect(
          (status.json as { data: { access: unknown } }).data.access,
        ).toEqual({ read_only: true, allowed_chats: null })
      } finally {
        await Bun.write(`${env.dataDir}/config.json`, '{}')
      }
    })
  })

  describe('allowedChats', () => {
    const ALLOWED = { TELEGRAM_SYNC_CLI_ALLOWED_CHATS: '@teamchat,me' }
    const scoped = PATHS.filter((path) => COMMAND_ACCESS[path]?.chatArgs)

    it('enumerates the chat-scoped commands from the tree', () => {
      expect(scoped).toEqual(
        expect.arrayContaining([
          'send',
          'chats get',
          'chats sync',
          'messages list',
          'messages get',
          'messages search',
          'messages wait',
          'messages watch',
          'messages unread',
          'messages read',
          'messages pin',
          'messages unpin',
          'media download',
        ]),
      )
    })

    for (const path of scoped) {
      it(`tg ${path} refuses a chat outside the list`, async () => {
        const { exitCode, json } = await refusal(
          argv(path, String(CLUB_ID)),
          ALLOWED,
        )
        expect(json.error).toMatchObject({
          code: 'CHAT_NOT_ALLOWED',
          details: { chat: String(CLUB_ID), id: CLUB_ID },
        })
        expect(exitCode).toBe(1)
      })
    }

    it('takes @username and its marked ID as one chat, and me as the own ID', async () => {
      for (const id of ['@teamchat', String(TEAM_ID)]) {
        const result = await runCliSuccess(
          ['chats', 'get', '--id', id],
          options(ALLOWED),
        )
        expect((result.json as { data: { id: number } }).data.id).toBe(TEAM_ID)
      }
      await runCliSuccess(
        ['messages', 'search', '--query', 'hello', '--chat', String(SELF_ID)],
        options(ALLOWED),
      )
      // Alice by her username is refused with her ID
      const { json } = await refusal(
        ['messages', 'list', '--chat', '@alice'],
        ALLOWED,
      )
      expect(json.error.details).toEqual({ chat: '@alice', id: ALICE_ID })
    })

    it('lists and searches only allowed chats', async () => {
      const list = await runCliSuccess(['chats', 'list'], options(ALLOWED))
      const listed = (list.json as { data: { items: { id: number }[] } }).data
      expect(listed.items.map((chat) => chat.id)).toEqual([TEAM_ID])

      const chats = await runCliSuccess(
        ['chats', 'search', '--query', 'C'],
        options(ALLOWED),
      )
      const found = (chats.json as { data: { results: { id: number }[] } }).data
      expect(found.results.map((chat) => chat.id)).toEqual([TEAM_ID])

      const messages = await runCliSuccess(
        ['messages', 'search', '--query', 'hello', '--count'],
        options(ALLOWED),
      )
      const data = (
        messages.json as {
          data: { results: { chatId: number }[]; count: number }
        }
      ).data
      expect(data.results.map((m) => m.chatId)).toEqual([TEAM_ID])
      expect(data.count).toBe(1)
    })

    it('lists unread messages and chats of allowed chats only', async () => {
      const list = await runCliSuccess(
        ['chats', 'list', '--unread'],
        options(ALLOWED),
      )
      const listed = (list.json as { data: { items: { id: number }[] } }).data
      expect(listed.items.map((chat) => chat.id)).toEqual([TEAM_ID])

      const unread = await runCliSuccess(
        ['messages', 'unread'],
        options(ALLOWED),
      )
      const data = (
        unread.json as {
          data: {
            chats: { chat: { id: number }; items: { messageId: number }[] }[]
          }
        }
      ).data
      expect(
        data.chats.map((chat) => [
          chat.chat.id,
          chat.items.map((m) => m.messageId),
        ]),
      ).toEqual([[TEAM_ID, [1]]])
    })

    it('tg messages wait without --chat returns only an allowed chat new message', async () => {
      // The test runner is alive: its PID and daemon rows make a running daemon
      const pidPath = join(env.dataDir, 'daemon.pid')
      await Bun.write(pidPath, String(process.pid))
      createDaemonStatusService(env.openCacheDb(1)).setDaemonRunning(
        process.pid,
        'test',
      )
      try {
        const proc = spawnCli(['messages', 'wait', '--timeout', '10'], {
          env: { ...options(ALLOWED).env, VERBOSE: '1' },
        })
        const stdout = new Response(proc.stdout).text()
        // Wait for the start point, then store a message in each chat at once
        const reader = proc.stderr.getReader()
        let stderr = ''
        while (!stderr.includes('Waiting for messages')) {
          const { value, done } = await reader.read()
          if (done) throw new Error(`wait exited: ${stderr}`)
          stderr += new TextDecoder().decode(value)
        }
        takePartIn(env.openCacheDb(1), TEAM_ID, CLUB_ID)
        createMessagesCache(env.openCacheDb(1)).upsertBatch([
          message(CLUB_PEER, 20, 'club news'),
          message(TEAM_PEER, 21, 'team news'),
        ])
        expect(await proc.exited).toBe(0)
        const result = JSON.parse(await stdout) as {
          data: { messages: { chatId: number; messageId: number }[] }
        }
        expect(
          result.data.messages.map((m) => [m.chatId, m.messageId]),
        ).toEqual([[TEAM_ID, 21]])
      } finally {
        rmSync(pidPath, { force: true })
      }
    })

    it('refuses tg sql and tg api while the list is set', async () => {
      for (const args of [
        ['sql', '--query', 'SELECT 1'],
        ['api', 'help.getConfig'],
      ]) {
        const { json } = await refusal(args, ALLOWED)
        expect(json.error).toMatchObject({
          code: 'CHAT_NOT_ALLOWED',
          details: { command: args[0] },
        })
      }
    })

    it('TELEGRAM_SYNC_CLI_ALLOWED_CHATS replaces the list in config.json', async () => {
      await Bun.write(
        `${env.dataDir}/config.json`,
        JSON.stringify({ allowedChats: [String(CLUB_ID)] }),
      )
      try {
        await runCliSuccess(
          ['chats', 'get', '--id', String(CLUB_ID)],
          options(),
        )
        const { json } = await refusal(
          ['chats', 'get', '--id', String(CLUB_ID)],
          ALLOWED,
        )
        expect(json.error.code).toBe('CHAT_NOT_ALLOWED')
        const status = await runCliSuccess(['status'], options(ALLOWED))
        expect(
          (status.json as { data: { access: unknown } }).data.access,
        ).toEqual({ read_only: false, allowed_chats: ['@teamchat', 'me'] })
      } finally {
        await Bun.write(`${env.dataDir}/config.json`, '{}')
      }
    })
  })
})
