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
/** Messages 100-109 were never fetched: a gap between two history ranges */
const GAP = { low: 100, high: 109 }
const CACHED_IDS = Array.from({ length: 160 }, (_, i) => i + 1).filter(
  (id) => id < GAP.low || id > GAP.high,
)
const isVoice = (id: number) => id % 15 === 7
/** A deleted voice note and a deleted text, both still cached */
const DELETED_IDS = [22, 120]
const LIVE_IDS = CACHED_IDS.filter((id) => !DELETED_IDS.includes(id))

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
  const raws = CACHED_IDS.map((id) => {
    const date = now - (160 - id) * 600
    if (isVoice(id)) return { ...voiceMessage(CLUB, id), fromId: MEMBER, date }
    const message =
      id === 150
        ? 'I paid for the rope repair, €18.25'
        : 'see you at the wall at 7'
    return { _: 'message', id, peerId: CLUB, fromId: MEMBER, date, message }
  })
  takePartIn(db, CLUB_ID)
  const messages = createMessagesCache(db)
  messages.upsertBatch(raws.map((raw) => parseRawMessage(raw, CLUB_ID)!))
  messages.markDeleted(CLUB_ID, DELETED_IDS)
  const ranges = createHistoryRanges(db)
  ranges.add(CLUB_ID, { low: 1, high: GAP.low - 1 })
  ranges.add(CLUB_ID, { low: GAP.high + 1, high: 160 })
}

type Rows = Record<string, unknown>[]

/** What a command needs beyond the cache, and what proves it ran */
function expectation(words: string[]): {
  needsTelegram?: boolean
  entry?: string
  rows?: (rows: Rows) => void
} {
  const [command, sub] = [words[1], words[2]]
  if (command === 'daemon' && sub === 'start') {
    // Needs Telegram: it gets past its arguments to the credentials check
    return { needsTelegram: true }
  }
  if (command === 'api') return { entry: FAKE_CLIENT_CLI }
  const query = words[words.indexOf('--query') + 1] ?? ''
  if (command === 'sql' && query.includes('message_attachments')) {
    const voices = LIVE_IDS.filter(isVoice).length
    return {
      rows: (rows) => expect(rows).toEqual([{ kind: 'voice', n: voices }]),
    }
  }
  if (command === 'sql' && query.includes('FROM messages_cache')) {
    return {
      rows: (rows) =>
        expect(rows.map((row) => row.message_id)).toEqual(LIVE_IDS),
    }
  }
  if (command === 'sql' && query.includes('history_ranges')) {
    return {
      rows: (rows) =>
        expect(rows).toEqual([
          { low: 1, high: GAP.low - 1 },
          { low: GAP.high + 1, high: 160 },
        ]),
    }
  }
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
    const { needsTelegram, entry, rows } = expectation(words)
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
    rows?.(data.rows as Rows)
  })

  it('asserts the answer of every SQL example', () => {
    const sql = commands.map(shellWords).filter((words) => words[1] === 'sql')
    expect(sql.length).toBeGreaterThan(0)
    expect(sql.every((words) => expectation(words).rows)).toBe(true)
  })
})
