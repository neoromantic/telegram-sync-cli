/**
 * E2E tests for `tg messages wait` and `tg messages watch`: another process
 * writes messages into the cache, the way the daemon stores them, while the
 * command runs. The test runner is alive, so a daemon.pid with its PID and
 * daemon rows for it make a running daemon.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { takePartIn } from '../__tests__/helpers/participation'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createChatsCache } from '../db/chats-cache'
import { createDaemonStatusService } from '../db/daemon-status'
import { createMessagesCache } from '../db/messages-cache'
import type { MessageSearchItem } from '../types'
import { toPeerIdFromRawPeer } from '../utils/telegram-peer-ids'
import { NO_CREDENTIALS, runCli, runCliSuccess, spawnCli } from './helpers/cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const TEAM_CHAT_PEER = { _: 'peerChannel', channelId: 1234567890 } as const
const TEAM_CHAT_ID = -1001234567890
const BOOK_CLUB_PEER = { _: 'peerChat', chatId: 4242 } as const
const ALICE_PEER = { _: 'peerUser', userId: 10 } as const

/** The line `--verbose` prints once the command has its start point */
const READY = 'Waiting for messages'

interface WaitData {
  messages: MessageSearchItem[]
  timedOut: boolean
}

function message(
  peer: typeof TEAM_CHAT_PEER | typeof BOOK_CLUB_PEER,
  id: number,
  text: string,
) {
  return parseRawMessage(
    {
      _: 'message',
      id,
      peerId: peer,
      fromId: ALICE_PEER,
      message: text,
      date: Math.floor(Date.now() / 1000) - 600 + id,
    },
    toPeerIdFromRawPeer(peer)!,
  )!
}

describe('E2E: messages wait and watch', () => {
  let env: TestEnvironment

  beforeEach(() => {
    env = createTestEnvironment('messages-wait')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000000', is_active: true }])
    const db = env.openCacheDb(1)
    createChatsCache(db).upsertMany(
      [
        fakeDialog({
          kind: 'supergroup',
          id: 1234567890,
          title: 'Team Chat',
          username: 'teamchat',
          membersCount: 3,
        }),
        fakeDialog({ kind: 'group', id: 4242, title: 'Book Club' }),
      ].map(dialogToCacheInput),
    )
    // Team Chat's messages 1-10, without 3 (history not backfilled yet),
    // and 10 deleted
    store(
      [1, 2, 4, 5, 6, 7, 8, 9, 10].map((id) => ({
        ...message(TEAM_CHAT_PEER, id, `old ${id}`),
        is_deleted: id === 10,
      })),
    )
  })

  afterEach(() => {
    env.cleanup()
  })

  function store(messages: ReturnType<typeof message>[]): void {
    takePartIn(env.openCacheDb(1), TEAM_CHAT_ID, -4242)
    createMessagesCache(env.openCacheDb(1)).upsertBatch(messages)
  }

  function startDaemon(): void {
    writeFileSync(join(env.dataDir, 'daemon.pid'), String(process.pid))
    createDaemonStatusService(env.openCacheDb(1)).setDaemonRunning(
      process.pid,
      'test',
    )
  }

  function options() {
    return { env: { ...env.getCliOptions().env, ...NO_CREDENTIALS } }
  }

  /** Start the command and collect its output as it comes */
  function start(args: string[]) {
    const proc = spawnCli(['messages', ...args], {
      env: { ...options().env, VERBOSE: '1' },
    })
    const output = { stdout: '', stderr: '' }
    const collect = async (
      stream: ReadableStream<Uint8Array>,
      key: keyof typeof output,
    ) => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) output[key] += decoder.decode(chunk)
    }
    const drained = Promise.all([
      collect(proc.stdout, 'stdout'),
      collect(proc.stderr, 'stderr'),
    ])
    const until = async (done: () => boolean) => {
      const deadline = Date.now() + 10_000
      while (!done()) {
        if (Date.now() > deadline) {
          throw new Error(`Timed out: ${JSON.stringify(output)}`)
        }
        await Bun.sleep(10)
      }
    }
    return {
      proc,
      output,
      ready: () => until(() => output.stderr.includes(READY)),
      lines: (count: number) =>
        until(() => output.stdout.split('\n').filter(Boolean).length >= count),
      async exited() {
        const exitCode = await proc.exited
        await drained
        return exitCode
      },
    }
  }

  it('returns within about a second of a new message being stored', async () => {
    startDaemon()
    const wait = start(['wait', '--timeout', '30'])
    await wait.ready()

    // History backfill (3) is not new; 11 is
    store([
      message(TEAM_CHAT_PEER, 3, 'old 3'),
      message(TEAM_CHAT_PEER, 11, 'hi'),
    ])
    const storedAt = performance.now()
    const exitCode = await wait.exited()
    const elapsed = performance.now() - storedAt

    expect(exitCode).toBe(0)
    expect(elapsed).toBeLessThan(1000)
    const json = JSON.parse(wait.output.stdout) as { data: WaitData }
    expect(json.data.timedOut).toBe(false)
    expect(json.data.messages.map((m) => [m.chatId, m.messageId])).toEqual([
      [TEAM_CHAT_ID, 11],
    ])
    expect(json.data.messages[0]).toMatchObject({
      text: 'hi',
      chat: { title: 'Team Chat', username: 'teamchat' },
      attachment: null,
      action: null,
    })
  })

  it('returns an empty result with timedOut after --timeout', async () => {
    startDaemon()
    const result = await runCliSuccess(
      ['messages', 'wait', '--timeout', '1'],
      options(),
    )

    expect(result.json).toEqual({
      success: true,
      data: { messages: [], timedOut: true },
    })
    expect(result.duration).toBeGreaterThanOrEqual(1000)
  })

  it('returns the cached messages after --after at once, deleted ones left out', async () => {
    startDaemon()
    const result = await runCliSuccess(
      ['messages', 'wait', '--chat', '@teamchat', '--after', '7'],
      options(),
    )

    const data = (result.json as { data: WaitData }).data
    expect(data.timedOut).toBe(false)
    expect(data.messages.map((m) => m.messageId)).toEqual([8, 9])
  })

  it('waits for a message after --after when none is cached', async () => {
    startDaemon()
    const wait = start(['wait', '--chat', '@teamchat', '--after', '10'])
    await wait.ready()
    store([message(TEAM_CHAT_PEER, 11, 'hi')])

    expect(await wait.exited()).toBe(0)
    const data = (JSON.parse(wait.output.stdout) as { data: WaitData }).data
    expect(data.messages.map((m) => m.messageId)).toEqual([11])
  })

  it('needs --chat for --after', async () => {
    startDaemon()
    const result = await runCli(['messages', 'wait', '--after', '5'], options())

    expect(result.exitCode).toBe(3)
    expect(result.json).toMatchObject({
      success: false,
      error: { code: 'INVALID_ARGS' },
    })
  })

  it('keeps collecting with --settle until no new message comes', async () => {
    startDaemon()
    const wait = start(['wait', '--chat', '@teamchat', '--settle', '1'])
    await wait.ready()

    store([message(TEAM_CHAT_PEER, 11, 'first')])
    await Bun.sleep(400)
    // Another chat's message doesn't count with --chat
    store([
      message(TEAM_CHAT_PEER, 12, 'second'),
      message(BOOK_CLUB_PEER, 13, 'elsewhere'),
    ])
    const lastAt = performance.now()

    expect(await wait.exited()).toBe(0)
    expect(performance.now() - lastAt).toBeGreaterThanOrEqual(1000)
    const data = (JSON.parse(wait.output.stdout) as { data: WaitData }).data
    expect(data.messages.map((m) => m.messageId)).toEqual([11, 12])
  })

  it('fails at once when the daemon is not running', async () => {
    const result = await runCli(['messages', 'wait'], options())

    expect(result.exitCode).toBe(1)
    expect(result.duration).toBeLessThan(5000)
    expect(result.json).toMatchObject({
      success: false,
      error: {
        code: 'DAEMON_NOT_RUNNING',
        details: { account_id: 1 },
        suggestion: 'Start it with tg daemon start, then retry',
      },
    })
  })

  it("fails when the live daemon doesn't run the account", async () => {
    startDaemon()
    // Rows a stopped daemon left: another PID
    createDaemonStatusService(env.openCacheDb(1)).set('daemon_pid', '1')
    const result = await runCli(['messages', 'watch'], options())

    expect(result.exitCode).toBe(1)
    expect(result.json).toMatchObject({
      error: { code: 'DAEMON_NOT_RUNNING' },
    })
  })

  it('watch prints one JSON line per new message and exits 0 on SIGTERM', async () => {
    startDaemon()
    const watch = start(['watch'])
    await watch.ready()

    store([message(TEAM_CHAT_PEER, 11, 'one')])
    await watch.lines(1)
    store([
      message(BOOK_CLUB_PEER, 12, 'two'),
      message(TEAM_CHAT_PEER, 13, 'three'),
    ])
    await watch.lines(3)
    watch.proc.kill('SIGTERM')

    expect(await watch.exited()).toBe(0)
    const items = watch.output.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as MessageSearchItem)
    expect(items.map((item) => [item.chatId, item.messageId])).toEqual([
      [TEAM_CHAT_ID, 11],
      [-4242, 12],
      [TEAM_CHAT_ID, 13],
    ])
    expect(items[0]?.text).toBe('one')
  })
})
