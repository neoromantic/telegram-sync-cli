/**
 * Runs every command in the code blocks of skills/telegram-sync-cli/SKILL.md
 * against a made-up cache, so the skill's examples can't go stale. The
 * examples name the chats seeded here.
 */
import type { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import { fakeDialog } from '../__tests__/helpers/fake-dialogs'
import { voiceMessage } from '../__tests__/helpers/media-messages'
import { takePartIn } from '../__tests__/helpers/participation'
import { dialogToCacheInput } from '../commands/chats/helpers'
import { parseRawMessage } from '../daemon/sync-worker-real-helpers'
import { createChatsCache } from '../db/chats-cache'
import { createHistoryRanges } from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { NO_CREDENTIALS, runCli } from './helpers/cli'
import { FAKE_CLIENT_CLI } from './helpers/fake-client-cli'
import { createTestEnvironment, type TestEnvironment } from './helpers/setup'

const SKILL_PATH = join(
  import.meta.dir,
  '../../skills/telegram-sync-cli/SKILL.md',
)

const CLUB_RAW_ID = 3000000001
const CLUB_ID = -1003000000001
const CLUB = { _: 'peerChannel', channelId: CLUB_RAW_ID } as const
const MEMBER = { _: 'peerUser', userId: 2001 } as const

const commands = skillCommands(await Bun.file(SKILL_PATH).text())

/** The commands of the skill's ```bash blocks, one per line */
function skillCommands(markdown: string): string[] {
  const blocks = markdown.match(/```bash\n[\s\S]*?```/g) ?? []
  return blocks.flatMap((block) =>
    block
      .split('\n')
      .slice(1, -1)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  )
}

/** Shell words of one command: quotes, a leading nohup, redirections and & dropped */
function shellWords(command: string): string[] {
  const words: string[] = []
  const pattern = /'([^']*)'|"([^"]*)"|(\S+)/g
  for (const match of command.matchAll(pattern)) {
    words.push(match[1] ?? match[2] ?? match[3]!)
  }
  const end = words.findIndex((word) => /^(\d?>|&|\|)/.test(word))
  const kept = end === -1 ? words : words.slice(0, end)
  return kept[0] === 'nohup' ? kept.slice(1) : kept
}

function seed(db: Database): void {
  createChatsCache(db).upsertMany([
    dialogToCacheInput(
      fakeDialog({
        kind: 'supergroup',
        id: CLUB_RAW_ID,
        title: 'Climbing Club',
        username: 'climbclub_example',
        membersCount: 4,
      }),
    ),
  ])
  const now = Math.floor(Date.now() / 1000)
  const raws = Array.from({ length: 160 }, (_, index) => {
    const id = index + 1
    const date = now - (160 - id) * 600
    if (id % 15 === 7)
      return { ...voiceMessage(CLUB, id), fromId: MEMBER, date }
    const message =
      id === 150
        ? 'I paid for the rope repair, €18.25'
        : 'see you at the wall at 7'
    return { _: 'message', id, peerId: CLUB, fromId: MEMBER, date, message }
  })
  takePartIn(db, CLUB_ID)
  createMessagesCache(db).upsertBatch(
    raws.map((raw) => parseRawMessage(raw, CLUB_ID)!),
  )
  createHistoryRanges(db).add(CLUB_ID, { low: 1, high: 160 })
}

/** What a command needs beyond the cache, and what proves it ran */
function expectation(words: string[]) {
  const [command, sub] = [words[1], words[2]]
  if (command === 'daemon' && sub === 'start') {
    // Needs Telegram: it gets past its arguments to the credentials check
    return { needsTelegram: true }
  }
  if (command === 'api') return { entry: FAKE_CLIENT_CLI }
  return {}
}

describe('E2E: the skill examples run', () => {
  let env: TestEnvironment

  beforeAll(() => {
    env = createTestEnvironment('skill-examples')
    env.initDatabase()
    env.seedAccounts([{ phone: '+15550000000', user_id: 999, is_active: true }])
    seed(env.openCacheDb(1))
  })

  afterAll(() => env.cleanup())

  it('finds the commands', () => {
    expect(commands.length).toBeGreaterThan(5)
    expect(commands.every((line) => shellWords(line)[0] === 'tg')).toBe(true)
  })

  it.each(commands)('%s', async (line) => {
    const words = shellWords(line)
    const { needsTelegram, entry } = expectation(words)
    const result = await runCli(words.slice(1), {
      env: { ...env.getCliOptions().env, ...NO_CREDENTIALS },
      entry,
      timeout: 20_000,
    })

    if (needsTelegram) {
      expect(result.stderr).toContain('TELEGRAM_API_ID')
      return
    }
    expect(result.exitCode).toBe(0)
    const { data } = result.json as {
      data: { items?: unknown[]; results?: unknown[]; rows?: unknown[] }
    }
    const list = data.items ?? data.results ?? data.rows
    if (list) expect(list.length).toBeGreaterThan(0)
  })
})
