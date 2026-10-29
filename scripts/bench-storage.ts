/**
 * Storage benchmark: builds a made-up account cache through tg's own write
 * paths and measures its size, write rates, query latency and maintenance.
 * See docs/storage.md for what it measures and the numbers.
 *
 *   bun run bench:storage [--messages N] [--out file.json] [--seed S]
 *                         [--runs R] [--cli-runs R] [--old-form] [--keep]
 *
 * --old-form writes the history as tg 0.5.0 and older wrote it instead and
 * times `tg db migrate` bringing it to the current form.
 *
 * Everything lives in a temp folder under $TMPDIR, removed at the end
 * (--keep leaves it). It never reads or writes ~/.telegram-sync-cli.
 */
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync, statfsSync } from 'node:fs'
import { release, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

import {
  type BenchChat,
  buildDataset,
  type Dataset,
  generateLiveMessage,
  generateMessage,
  messageIdAt,
  pageUsers,
  rng,
  SELF_ID,
  wordsOf,
} from './bench-storage-data'

const { values: args } = parseArgs({
  options: {
    messages: { type: 'string', default: '100000' },
    out: { type: 'string' },
    seed: { type: 'string', default: '1' },
    runs: { type: 'string', default: '20' },
    'cli-runs': { type: 'string', default: '5' },
    'old-form': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
})

const MESSAGES = Number.parseInt(args.messages ?? '', 10)
const SEED = Number.parseInt(args.seed ?? '', 10)
const RUNS = Number.parseInt(args.runs ?? '', 10)
const CLI_RUNS = Number.parseInt(args['cli-runs'] ?? '', 10)
const OLD_FORM = args['old-form'] ?? false
for (const [name, value] of Object.entries({
  messages: MESSAGES,
  seed: SEED,
  runs: RUNS,
  'cli-runs': CLI_RUNS,
})) {
  if (!Number.isSafeInteger(value) || value < 1) {
    console.error(`--${name} must be a positive integer`)
    process.exit(2)
  }
}

/** Messages per history page, as the daemon and the CLI fetch them */
const PAGE_SIZE = 100
const ROOT = resolve(import.meta.dir, '..')

// The data dir must be set before src/db/index.ts is imported: it opens
// <dataDir>/data.db at import time
const dataDir = mkdtempSync(join(tmpdir(), 'tg-bench-'))
process.env.TELEGRAM_SYNC_CLI_DATA_DIR = dataDir
process.env.TELEGRAM_SYNC_CLI_TELEMETRY = '0'

const {
  accountsDb,
  closeAccountCacheDbs,
  getAccountCacheDb,
  getAccountCachePath,
  openReadOnlyAccountCacheDb,
} = await import('../src/db/index')
const { createChatsCache } = await import('../src/db/chats-cache')
const { createUsersCache } = await import('../src/db/users-cache')
const { createMessagesCache } = await import('../src/db/messages-cache')
const { createMessagesSearch } = await import('../src/db/messages-search')
const { createHistoryRanges } = await import('../src/db/history-ranges')
const { readCacheSize } = await import('../src/db/cache-maintenance')
const { rebuildMessageSearchIndex } = await import('../src/db/sync-schema')
const { readMigrationStatus, registerBackgroundMigrations } = await import(
  '../src/db/background-migrations'
)
const { cacheHistoryResponse, getMessageWithContext, listHistory } =
  await import('../src/commands/messages/history')
const { messageItemReader } = await import('../src/commands/messages/helpers')
const { readAccountStatus } = await import('../src/commands/status')
const { createMessageInputs, parseRawMessage } = await import(
  '../src/daemon/sync-worker-real-helpers'
)
const { resolveRawMessageType } = await import('../src/utils/message-type')
const { apiUserToCacheInput } = await import('../src/utils/telegram-mappers')
const { rawChatToCacheInput, userToPrivateChatCacheInput } = await import(
  '../src/commands/chats/helpers'
)
const { buildSnippet, snippetTerms } = await import(
  '../src/utils/search-snippet'
)
const { applyQueryLimit } = await import('../src/commands/sql/helpers')
const { VERSION } = await import('../src/version')

type RawUser = Parameters<typeof apiUserToCacheInput>[0]
type RawChat = Parameters<typeof rawChatToCacheInput>[0]
type PageUsers = Parameters<typeof cacheHistoryResponse>[3]

// ── Helpers ─────────────────────────────────────────────────────────────

function log(message: string): void {
  console.error(`[bench] ${message}`)
}

interface Timing {
  median_ms: number
  p95_ms: number
  first_ms: number
  runs: number
}

function round(value: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(value * f) / f
}

function summarize(samples: number[], first: number): Timing {
  const sorted = [...samples].sort((a, b) => a - b)
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] ?? 0
  return {
    median_ms: round(at(0.5), 3),
    p95_ms: round(at(0.95), 3),
    first_ms: round(first, 3),
    runs: samples.length,
  }
}

/** The first run, then `runs` timed runs; returns the timing and the last result */
async function time<T>(
  runs: number,
  fn: () => T | Promise<T>,
): Promise<{ timing: Timing; result: T }> {
  let start = performance.now()
  let result = await fn()
  const first = performance.now() - start
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    start = performance.now()
    result = await fn()
    samples.push(performance.now() - start)
  }
  return { timing: summarize(samples, first), result }
}

function fileBytes(path: string): number {
  return Bun.file(path).size
}

/**
 * Watch free disk and the WAL while another process works on the cache.
 * `stop()` returns the most disk it took beyond the start and the biggest
 * WAL seen.
 */
function watchDisk(cachePath: string) {
  const free = () => {
    const stat = statfsSync(dataDir)
    return Number(stat.bavail) * Number(stat.bsize)
  }
  const freeBefore = free()
  let minFree = freeBefore
  let maxWal = 0
  const poll = setInterval(() => {
    minFree = Math.min(minFree, free())
    maxWal = Math.max(maxWal, fileBytes(`${cachePath}-wal`))
  }, 25)
  return {
    stop() {
      clearInterval(poll)
      return {
        peak_extra_disk_bytes: Math.max(0, freeBefore - minFree),
        peak_wal_bytes: maxWal,
      }
    },
  }
}

/** Run `tg <argv>` from source as a new process; its time and stdout */
async function cli(argv: string[]): Promise<{ ms: number; stdout: string }> {
  const start = performance.now()
  const proc = Bun.spawn(
    ['bun', '--no-env-file', join(ROOT, 'src/index.ts'), ...argv],
    {
      cwd: dataDir,
      env: {
        ...process.env,
        TELEGRAM_SYNC_CLI_DATA_DIR: dataDir,
        TELEGRAM_SYNC_CLI_TELEMETRY: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const ms = performance.now() - start
  if (code !== 0) {
    throw new Error(`tg ${argv.join(' ')} exited ${code}: ${stderr || stdout}`)
  }
  return { ms, stdout }
}

async function timeCli(argv: string[]): Promise<Timing> {
  const first = (await cli(argv)).ms
  const samples: number[] = []
  for (let i = 0; i < CLI_RUNS; i++) samples.push((await cli(argv)).ms)
  return summarize(samples, first)
}

/** A client that fails the run if a command tries to reach Telegram */
const offlineClient = {
  call: () => {
    throw new Error('The benchmark is offline: the cache should answer')
  },
  getMe: () => {
    throw new Error('The benchmark is offline')
  },
} as unknown as Parameters<typeof listHistory>[0]['client']

function historyChat(chat: BenchChat) {
  const inputPeer =
    chat.kind === 'private'
      ? { _: 'inputPeerUser', userId: chat.peerId, accessHash: 0n }
      : chat.kind === 'group'
        ? { _: 'inputPeerChat', chatId: chat.peerId }
        : { _: 'inputPeerChannel', channelId: chat.peerId, accessHash: 0n }
  return { chatId: chat.chatId, inputPeer } as unknown as Parameters<
    typeof listHistory
  >[0]['chat']
}

/** A chat's history page `p`, newest first; page 0 is the newest */
function historyPage(data: Dataset, chat: BenchChat, p: number) {
  const high = chat.size - 1 - p * PAGE_SIZE
  const low = Math.max(0, high - PAGE_SIZE + 1)
  const messages: Array<Record<string, unknown>> = []
  for (let i = high; i >= low; i--) {
    messages.push(generateMessage(data, chat, i))
  }
  return {
    messages,
    bounds: {
      before: p === 0 ? undefined : messageIdAt(chat, high + 1),
      reachedStart: low === 0,
    },
  }
}

function pagesOf(chat: BenchChat): number {
  return Math.ceil(chat.size / PAGE_SIZE)
}

function count(db: Database, sql: string): number {
  return (db.query(sql).get() as { n: number }).n
}

// ── Writes ──────────────────────────────────────────────────────────────

/**
 * Users and chats first: the search index reads sender and chat names when
 * a message row is written. `oldForm` stores raw_json as plain
 * JSON.stringify writes it, as tg 0.5.0 and older did.
 */
function writePeers(db: Database, data: Dataset, oldForm: boolean): void {
  const usersCache = createUsersCache(db)
  const chatsCache = createChatsCache(db)
  const raw = <T extends { raw_json: string }>(input: T, value: unknown): T =>
    oldForm ? { ...input, raw_json: JSON.stringify(value) } : input
  db.transaction(() => {
    usersCache.upsert(
      apiUserToCacheInput({
        _: 'user',
        self: true,
        id: SELF_ID,
        firstName: 'Bench',
        lastName: 'Account',
      } as RawUser),
    )
    for (const user of data.users) {
      const value = user.raw as unknown as RawUser
      usersCache.upsert(raw(apiUserToCacheInput(value), value))
    }
    for (const chat of data.chats) {
      if (chat.kind === 'private') {
        const value = data.users[chat.peerId - SELF_ID - 1]!
          .raw as unknown as RawUser
        chatsCache.upsert(raw(userToPrivateChatCacheInput(value), value))
      } else {
        const value = chat.raw as unknown as RawChat
        chatsCache.upsert(raw(rawChatToCacheInput(value), value))
      }
    }
  })()
}

/** The message_type tg 0.5.0 and older stored for a history page message */
function oldMessageType(message: Record<string, unknown>): string {
  const media = message.media as { _?: string } | undefined
  if (media?._ === 'messageMediaDocument') return 'document'
  return resolveRawMessageType(message).messageType
}

/**
 * A history page as tg 0.5.0 and older wrote it: raw_json by plain
 * JSON.stringify (byte arrays as objects with a key per byte, Long values
 * as `{ low, high, unsigned }`, fileReference kept) and every file a
 * `document`. Its attachment rows are dropped afterwards.
 */
function writeOldFormPage(
  db: Database,
  chat: BenchChat,
  page: ReturnType<typeof historyPage>,
  users: Array<Record<string, unknown>>,
): void {
  const usersCache = createUsersCache(db)
  const messagesCache = createMessagesCache(db)
  const { inputs } = createMessageInputs(
    page.messages,
    chat.chatId,
    Number.MAX_SAFE_INTEGER,
    0,
  )
  inputs.forEach((input, k) => {
    const raw = page.messages[k]!
    input.raw_json = JSON.stringify(raw)
    input.message_type = oldMessageType(raw)
  })
  db.transaction(() => {
    for (const user of users) {
      usersCache.upsert({
        ...apiUserToCacheInput(user as unknown as RawUser),
        raw_json: JSON.stringify(user),
      })
    }
    messagesCache.upsertBatch(inputs)
    createHistoryRanges(db).recordPage(
      chat.chatId,
      inputs.map((input) => input.message_id),
      page.bounds,
    )
  })()
}

/** Every chat's pages newest first, as history sync fetches them */
function writeHistory(db: Database, data: Dataset, oldForm: boolean) {
  let ms = 0
  let written = 0
  const reportEvery = Math.max(100_000, Math.round(MESSAGES / 10))
  let nextReport = reportEvery
  for (const chat of data.chats) {
    for (let p = 0; p < pagesOf(chat); p++) {
      const page = historyPage(data, chat, p)
      const users = pageUsers(data, page.messages)
      const start = performance.now()
      if (oldForm) writeOldFormPage(db, chat, page, users)
      else {
        cacheHistoryResponse(
          db,
          chat.chatId,
          page.messages,
          users as unknown as PageUsers,
          page.bounds,
        )
      }
      ms += performance.now() - start
      written += page.messages.length
      if (written >= nextReport) {
        log(`  ${written.toLocaleString('en-US')} messages`)
        nextReport += reportEvery
      }
    }
  }
  return {
    messages: written,
    seconds: round(ms / 1000, 2),
    messages_per_s: Math.round(written / (ms / 1000)),
  }
}

/** About 1 in 100 messages marked deleted, as delete updates do */
function markDeletions(db: Database, data: Dataset): void {
  const messagesCache = createMessagesCache(db)
  const r = rng(SEED * 7919)
  for (const chat of data.chats) {
    const ids: number[] = []
    for (let i = 0; i < chat.size; i++) {
      if (r() < 0.01) ids.push(messageIdAt(chat, i))
    }
    if (ids.length > 0) messagesCache.markDeleted(chat.chatId, ids)
  }
}

// ── Sizes ───────────────────────────────────────────────────────────────

/** The cache's size by table, as `tg status --sizes` counts it, and raw_json's share */
function measureSize(db: Database, cachePath: string) {
  db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  const messages = count(db, 'SELECT COUNT(*) AS n FROM messages_cache')
  const size = readCacheSize(db, cachePath, { tables: true })
  const tables: Record<
    string,
    { bytes: number; per_message: number; share: number }
  > = {}
  for (const [name, bytes] of Object.entries(size.tables ?? {}).sort(
    (a, b) => b[1] - a[1],
  )) {
    tables[name] = {
      bytes,
      per_message: round(bytes / messages, 1),
      share: round(bytes / size.file_bytes, 4),
    }
  }
  const rows = db
    .query(
      `SELECT message_type AS type, COUNT(*) AS n,
              SUM(LENGTH(CAST(raw_json AS BLOB))) AS raw,
              SUM(LENGTH(CAST(COALESCE(text, '') AS BLOB))) AS text
       FROM messages_cache GROUP BY message_type ORDER BY n DESC`,
    )
    .all() as Array<{ type: string; n: number; raw: number; text: number }>
  const raw = rows.reduce((sum, row) => sum + row.raw, 0)
  const text = rows.reduce((sum, row) => sum + row.text, 0)
  return {
    messages,
    file_bytes: size.file_bytes,
    wal_bytes: size.wal_bytes,
    page_size: size.page_size,
    free_bytes: size.free_bytes,
    bytes_per_message: Math.round(size.file_bytes / messages),
    tables,
    raw_json: {
      bytes: raw,
      per_message: Math.round(raw / messages),
      share_of_file: round(raw / size.file_bytes, 4),
    },
    text: { bytes: text, per_message: Math.round(text / messages) },
    by_type: Object.fromEntries(
      rows.map((row) => [
        row.type,
        { messages: row.n, raw_json_avg_bytes: Math.round(row.raw / row.n) },
      ]),
    ),
  }
}

/**
 * raw_json of an even sample of rows compressed row by row (gzip, zstd),
 * and the whole sample as one zstd stream: the most a shared dictionary
 * could approach (#97). Nothing is written back.
 */
function measureRawJsonCompression(db: Database, total: number) {
  const step = Math.max(1, Math.floor(total / 20_000))
  const rows = db
    .query('SELECT raw_json FROM messages_cache WHERE rowid % ? = 0')
    .all(step) as Array<{ raw_json: string }>
  const encoder = new TextEncoder()
  const sums = { stored: 0, gzip_row: 0, zstd_row: 0 }
  for (const row of rows) {
    const bytes = encoder.encode(row.raw_json)
    sums.stored += bytes.length
    sums.gzip_row += Bun.gzipSync(bytes).length
    sums.zstd_row += Bun.zstdCompressSync(bytes).length
  }
  const all = rows.map((row) => row.raw_json).join('\n')
  const stream = Bun.zstdCompressSync(encoder.encode(all)).length
  const per = (bytes: number) => Math.round(bytes / Math.max(1, rows.length))
  return {
    sample_rows: rows.length,
    per_message: {
      stored: per(sums.stored),
      gzip_row: per(sums.gzip_row),
      zstd_row: per(sums.zstd_row),
      zstd_whole_sample: per(stream),
    },
  }
}

// ── Runs ────────────────────────────────────────────────────────────────

interface RunContext {
  accountId: number
  db: Database
  cachePath: string
  data: Dataset
}

function describe(data: Dataset, sqliteVersion: string) {
  return {
    benchmark: 'tg storage',
    format: 1,
    mode: OLD_FORM ? 'old-form' : 'current',
    tg_version: VERSION,
    machine: {
      os: `${process.platform} ${release()}`,
      arch: process.arch,
      bun: Bun.version,
      sqlite: sqliteVersion,
    },
    params: {
      messages: MESSAGES,
      seed: SEED,
      chats: data.chats.length,
      chat_kinds: Object.fromEntries(
        (['private', 'group', 'supergroup', 'channel'] as const).map((kind) => [
          kind,
          data.chats.filter((chat) => chat.kind === kind).length,
        ]),
      ),
      biggest_chats: data.chats
        .slice(0, 3)
        .map((chat) => ({ kind: chat.kind, messages: chat.size })),
      users: data.users.length,
      vocabulary: data.vocab.length,
      page_size: PAGE_SIZE,
      runs: RUNS,
      cli_runs: CLI_RUNS,
    },
  }
}

/** The cache as this version writes it: writes, size, queries, maintenance */
async function runCurrent({ accountId, db, cachePath, data }: RunContext) {
  log('writing history pages')
  const history = writeHistory(db, data, false)

  // Re-fetch: the newest pages again, unchanged (#87)
  log('fetching pages again unchanged')
  db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  // fetched_at is in ms: the last history write must be older than this
  Bun.sleepSync(2)
  const refetchStart = Date.now()
  let refetchMs = 0
  let refetched = 0
  const refetchTarget = Math.min(
    20_000,
    Math.max(1000, Math.round(MESSAGES / 20)),
  )
  for (const chat of data.chats) {
    for (let p = 0; p < pagesOf(chat) && refetched < refetchTarget; p++) {
      const page = historyPage(data, chat, p)
      const users = pageUsers(data, page.messages)
      const start = performance.now()
      cacheHistoryResponse(
        db,
        chat.chatId,
        page.messages,
        users as unknown as PageUsers,
        page.bounds,
      )
      refetchMs += performance.now() - start
      refetched += page.messages.length
    }
    if (refetched >= refetchTarget) break
  }
  const rewritten = (
    db
      .query('SELECT COUNT(*) AS n FROM messages_cache WHERE fetched_at >= ?')
      .get(refetchStart) as { n: number }
  ).n
  const refetchWal = fileBytes(`${cachePath}-wal`)

  // Live: one message per write transaction, as the daemon's updates come.
  // Not the biggest chat: live messages record no history range, so its
  // newest page would go to Telegram.
  log('writing live messages one by one')
  const messagesCache = createMessagesCache(db)
  const liveChats = data.chats.slice(1, 11)
  const liveCount = Math.min(5000, Math.max(500, Math.round(MESSAGES / 200)))
  let liveMs = 0
  for (let n = 0; n < liveCount; n++) {
    const chat = liveChats[n % liveChats.length]!
    const raw = generateLiveMessage(
      data,
      chat,
      Math.floor(n / liveChats.length),
    )
    const start = performance.now()
    const input = parseRawMessage(raw, chat.chatId)
    if (input) messagesCache.upsert(input)
    liveMs += performance.now() - start
  }

  log('marking deleted messages')
  markDeletions(db, data)

  log('measuring sizes')
  const size = measureSize(db, cachePath)
  const flags = db
    .query(
      `SELECT SUM(reply_to_id IS NOT NULL) AS replies, SUM(is_edited) AS edited,
              SUM(forward_from_id IS NOT NULL) AS forwarded, SUM(is_deleted) AS deleted,
              SUM(text IS NOT NULL) AS with_text
       FROM messages_cache`,
    )
    .get() as Record<string, number>
  const compression = measureRawJsonCompression(db, size.messages)
  const attachments = count(db, 'SELECT COUNT(*) AS n FROM message_attachments')

  // ── Queries ───────────────────────────────────────────────────────────
  log('timing queries')
  // Latin words match one form; Cyrillic stems take endings, for `stem*`
  const latin = wordsOf(data, false)
  const common = latin[0]!
  const twoWords = `${latin[10]} ${latin[100]}`
  const rare = latin[5000]!
  const stem = wordsOf(data, true)[25]!
  const phrase = `${latin[0]} ${latin[1]}`
  const bigChat = data.chats[0]!
  const search = createMessagesSearch(db)
  const toItem = messageItemReader(db)

  /** `tg messages search` minus printing: the query, items and snippets */
  function runSearch(
    query: string,
    options: Parameters<typeof search.search>[1] & {
      snippet?: boolean
      count?: boolean
    } = {},
  ) {
    const { snippet, count, ...rest } = options
    const rows = search.search(query, { limit: 50, ...rest })
    const terms = snippet ? snippetTerms(query, { phrase: rest.phrase }) : []
    const items = rows.map((row) =>
      snippet
        ? { ...toItem(row), snippet: buildSnippet(row.text, terms) }
        : toItem(row),
    )
    const total = count ? search.count(query, rest) : null
    return { results: items.length, count: total }
  }

  const mid = Math.floor(bigChat.size / 2)
  const list = (window: { limit: number; before?: number }) => async () => {
    const result = await listHistory({
      cacheDb: db,
      client: offlineClient,
      chat: historyChat(bigChat),
      window,
      includeDeleted: false,
      fresh: false,
    })
    return { items: result.items.length, source: result.source }
  }

  const cases: Array<[string, string, () => unknown]> = [
    ['search_rare_word', rare, () => runSearch(rare)],
    ['search_common_word', common, () => runSearch(common)],
    ['search_two_words', twoWords, () => runSearch(twoWords)],
    [
      'search_phrase',
      `--phrase "${phrase}"`,
      () => runSearch(phrase, { phrase: true }),
    ],
    ['search_prefix', `${stem}*`, () => runSearch(`${stem}*`)],
    [
      'search_chat',
      `${common} --chat <biggest chat>`,
      () => runSearch(common, { chatId: bigChat.chatId }),
    ],
    [
      'search_relevance_common',
      `${common} --sort relevance`,
      () => runSearch(common, { sort: 'relevance' }),
    ],
    [
      'search_relevance_two_words',
      `${twoWords} --sort relevance`,
      () => runSearch(twoWords, { sort: 'relevance' }),
    ],
    [
      'search_count_common',
      `${common} --count`,
      () => runSearch(common, { count: true }),
    ],
    [
      'search_count_rare',
      `${rare} --count`,
      () => runSearch(rare, { count: true }),
    ],
    [
      'search_snippet',
      `${twoWords} --snippet`,
      () => runSearch(twoWords, { snippet: true }),
    ],
    [
      'list_newest_page',
      'messages list --chat <biggest chat> (20, newest)',
      list({ limit: 20 }),
    ],
    [
      'list_deep_page',
      'messages list --chat <biggest chat> --before <middle> (20)',
      list({ limit: 20, before: messageIdAt(bigChat, mid) }),
    ],
    [
      'get_context',
      'messages get --chat <biggest chat> <middle> --context 5',
      async () => {
        const result = await getMessageWithContext({
          cacheDb: db,
          client: offlineClient,
          chat: historyChat(bigChat),
          messageId: messageIdAt(bigChat, mid + 1),
          context: 5,
          includeDeleted: false,
          fresh: false,
        })
        return {
          newer: result.newer.length,
          older: result.older.length,
          source: result.source,
        }
      },
    ],
  ]
  const queries: Record<string, Timing & { query: string; result: unknown }> =
    {}
  for (const [name, query, fn] of cases) {
    const { timing, result } = await time(RUNS, fn)
    queries[name] = { query, ...timing, result }
  }

  // tg sql: a read-only connection, as the command opens it
  const sqlFts = `SELECT chat_id, COUNT(*) AS n FROM message_search_text WHERE message_search_text MATCH '${twoWords}' GROUP BY chat_id ORDER BY n DESC LIMIT 10`
  const sqlScan =
    'SELECT message_type, COUNT(*) AS n, SUM(LENGTH(raw_json)) AS raw FROM messages_cache GROUP BY message_type'
  const sqlDb = openReadOnlyAccountCacheDb(accountId)
  for (const [name, query] of [
    ['sql_fts_aggregate', sqlFts],
    ['sql_scan_aggregate', sqlScan],
  ] as const) {
    const { timing, result } = await time(
      Math.min(RUNS, 5),
      () => sqlDb.query(applyQueryLimit(query, 1000)).all().length,
    )
    queries[name] = { query, ...timing, result: { rows: result } }
  }
  sqlDb.close()

  for (const [name, sizes] of [
    ['status', false],
    ['status_sizes', true],
  ] as const) {
    const { timing } = await time(Math.min(RUNS, 5), () =>
      readAccountStatus(accountId, { sizes }),
    )
    queries[name] = {
      query: sizes ? 'tg status --sizes' : 'tg status',
      ...timing,
      result: null,
    }
  }

  // The CLI end to end, process start included
  log('timing CLI commands')
  const cliTimes: Record<string, Timing & { command: string }> = {}
  for (const [name, argv] of [
    ['help', ['--help']],
    ['status', ['status']],
    ['status_sizes', ['status', '--sizes']],
    ['search_common_word', ['messages', 'search', '--query', common]],
    ['search_rare_word', ['messages', 'search', '--query', rare]],
    ['sql_fts_aggregate', ['sql', '--query', sqlFts]],
  ] as const) {
    cliTimes[name] = {
      command: `tg ${argv.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`,
      ...(await timeCli([...argv])),
    }
  }

  // ── Maintenance ───────────────────────────────────────────────────────
  log('rebuilding the search index')
  let start = performance.now()
  rebuildMessageSearchIndex(db)
  const rebuildSeconds = (performance.now() - start) / 1000
  db.run('PRAGMA wal_checkpoint(TRUNCATE)')
  const afterRebuild = readCacheSize(db, cachePath, { tables: true })

  log('running tg db vacuum')
  closeAccountCacheDbs()
  const bytesBefore = fileBytes(cachePath)
  const watch = watchDisk(cachePath)
  start = performance.now()
  await cli(['db', 'vacuum'])
  const vacuumSeconds = (performance.now() - start) / 1000
  const disk = watch.stop()

  return {
    mix: {
      total_messages: size.messages,
      by_type: size.by_type,
      replies: flags.replies,
      edited: flags.edited,
      forwarded: flags.forwarded,
      deleted: flags.deleted,
      with_text: flags.with_text,
      attachments,
    },
    writes: {
      history,
      refetch_unchanged: {
        messages: refetched,
        seconds: round(refetchMs / 1000, 2),
        messages_per_s: Math.round(refetched / (refetchMs / 1000)),
        rows_rewritten: rewritten,
        wal_bytes: refetchWal,
      },
      live_single: {
        messages: liveCount,
        seconds: round(liveMs / 1000, 2),
        messages_per_s: Math.round(liveCount / (liveMs / 1000)),
      },
    },
    size: { ...size, raw_json_compression: compression },
    queries,
    cli: cliTimes,
    maintenance: {
      search_rebuild: {
        seconds: round(rebuildSeconds, 2),
        index_bytes_before: size.tables.message_search?.bytes ?? 0,
        index_bytes_after: afterRebuild.tables?.message_search ?? 0,
      },
      vacuum: {
        seconds: round(vacuumSeconds, 2),
        bytes_before: bytesBefore,
        bytes_after: fileBytes(cachePath),
        ...disk,
      },
    },
  }
}

/**
 * A cache tg 0.5.0 or older wrote, as an upgrade finds it: then `tg db
 * migrate` brings every row to the current form (#89), and `tg db vacuum`
 * gives the space back
 */
async function runOldForm({ accountId, db, cachePath, data }: RunContext) {
  log('writing history pages in the old form')
  const history = writeHistory(db, data, true)
  markDeletions(db, data)
  // An old cache has no attachment rows and registers the migrations as
  // pending on its first open by this version
  db.run('DELETE FROM message_attachments')
  db.run('DROP TABLE cache_migrations')
  registerBackgroundMigrations(db)

  log('measuring sizes')
  const before = measureSize(db, cachePath)
  const pending = readMigrationStatus(db).map((m) => m.name)

  log('running tg db migrate')
  closeAccountCacheDbs()
  let watch = watchDisk(cachePath)
  let start = performance.now()
  const migrate = JSON.parse((await cli(['db', 'migrate'])).stdout) as {
    data: { rows: number; migrations: Array<{ state: string }> }
  }
  const migrateSeconds = (performance.now() - start) / 1000
  const migrateDisk = watch.stop()

  const migrated = getAccountCacheDb(accountId)
  const after = measureSize(migrated, cachePath)
  const oldRowsLeft = count(
    migrated,
    `SELECT COUNT(*) AS n FROM messages_cache
     WHERE raw_json LIKE '%"unsigned":%' OR raw_json LIKE '%"fileReference"%'`,
  )
  const attachments = count(
    migrated,
    'SELECT COUNT(*) AS n FROM message_attachments',
  )

  log('running tg db vacuum')
  closeAccountCacheDbs()
  const bytesBefore = fileBytes(cachePath)
  watch = watchDisk(cachePath)
  start = performance.now()
  await cli(['db', 'vacuum'])
  const vacuumSeconds = (performance.now() - start) / 1000
  const vacuumDisk = watch.stop()
  const vacuumed = measureSize(getAccountCacheDb(accountId), cachePath)

  return {
    writes: { history_old_form: history },
    size_old_form: before,
    migration: {
      pending,
      seconds: round(migrateSeconds, 2),
      rows: migrate.data.rows,
      rows_per_s: Math.round(migrate.data.rows / migrateSeconds),
      all_done: migrate.data.migrations.every((m) => m.state === 'done'),
      old_form_rows_left: oldRowsLeft,
      attachments,
      ...migrateDisk,
    },
    size_after_migration: after,
    vacuum: {
      seconds: round(vacuumSeconds, 2),
      bytes_before: bytesBefore,
      bytes_after: fileBytes(cachePath),
      ...vacuumDisk,
    },
    size_after_vacuum: vacuumed,
  }
}

// ── Main ────────────────────────────────────────────────────────────────

const startedAt = performance.now()

try {
  const account = accountsDb.create({
    phone: '+15550000000',
    user_id: SELF_ID,
    name: 'Bench Account',
    is_active: true,
  })
  const db = getAccountCacheDb(account.id)
  const cachePath = getAccountCachePath(account.id)
  const sqliteVersion = (
    db.query('SELECT sqlite_version() AS v').get() as { v: string }
  ).v

  log(
    `building the dataset: ${MESSAGES.toLocaleString('en-US')} messages, seed ${SEED}${OLD_FORM ? ', old form' : ''}`,
  )
  const data = buildDataset(SEED, MESSAGES)
  writePeers(db, data, OLD_FORM)

  const context = { accountId: account.id, db, cachePath, data }
  const head = describe(data, sqliteVersion)
  const result = OLD_FORM
    ? { ...head, ...(await runOldForm(context)) }
    : { ...head, ...(await runCurrent(context)) }
  const output = {
    ...result,
    total_seconds: round((performance.now() - startedAt) / 1000, 1),
  }

  if (args.out) {
    await Bun.write(args.out, `${JSON.stringify(output, null, 2)}\n`)
  }
  console.log(JSON.stringify(output, null, 2))
  console.log()
  console.log(
    'migration' in output ? markdownOldForm(output) : markdown(output),
  )
} finally {
  closeAccountCacheDbs()
  if (args.keep) log(`kept ${dataDir}`)
  else rmSync(dataDir, { recursive: true, force: true })
}

// ── Markdown ────────────────────────────────────────────────────────────

/** Decimal megabytes, as docs/storage.md gives sizes */
function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`
}

function n(value: number): string {
  return value.toLocaleString('en-US')
}

type Size = ReturnType<typeof measureSize>
type Head = ReturnType<typeof describe>

function heading(r: Head): string {
  return `## ${n(r.params.messages)} messages, ${r.mode} (${r.machine.os}, ${r.machine.arch}, Bun ${r.machine.bun}, SQLite ${r.machine.sqlite})`
}

function sizeLines(size: Size): string[] {
  const lines = [
    `File ${mb(size.file_bytes)}, ${n(size.bytes_per_message)} B per message; raw_json ${n(size.raw_json.per_message)} B per message (${Math.round(size.raw_json.share_of_file * 100)}% of the file).`,
    '',
    '| Table | Size | B/message | Share |',
    '|---|---:|---:|---:|',
  ]
  for (const [name, t] of Object.entries(size.tables)) {
    if (t.share < 0.001) continue
    lines.push(
      `| \`${name}\` | ${mb(t.bytes)} | ${n(t.per_message)} | ${(t.share * 100).toFixed(1)}% |`,
    )
  }
  return lines
}

function markdown(
  r: Head & Awaited<ReturnType<typeof runCurrent>> & { total_seconds: number },
): string {
  const lines = [heading(r), '', ...sizeLines(r.size), '']
  lines.push('| raw_json compression (sample) | B/message |', '|---|---:|')
  for (const [name, bytes] of Object.entries(
    r.size.raw_json_compression.per_message,
  )) {
    lines.push(`| ${name} | ${n(bytes)} |`)
  }
  lines.push('', '| Write | Messages | Messages/s |', '|---|---:|---:|')
  for (const [name, w] of Object.entries(r.writes)) {
    const extra =
      'rows_rewritten' in w ? ` (${n(w.rows_rewritten)} rows rewritten)` : ''
    lines.push(
      `| ${name}${extra} | ${n(w.messages)} | ${n(w.messages_per_s)} |`,
    )
  }
  lines.push(
    '',
    '| Query (in process) | Median ms | p95 ms | First ms |',
    '|---|---:|---:|---:|',
  )
  for (const [name, q] of Object.entries(r.queries)) {
    lines.push(`| ${name} | ${q.median_ms} | ${q.p95_ms} | ${q.first_ms} |`)
  }
  lines.push(
    '',
    '| CLI command (process start included) | Median ms | p95 ms |',
    '|---|---:|---:|',
  )
  for (const [name, q] of Object.entries(r.cli)) {
    lines.push(`| ${name} | ${q.median_ms} | ${q.p95_ms} |`)
  }
  const v = r.maintenance.vacuum
  lines.push(
    '',
    `Search index rebuild ${r.maintenance.search_rebuild.seconds} s. \`tg db vacuum\` ${v.seconds} s, ${mb(v.bytes_before)} → ${mb(v.bytes_after)}, peak extra disk ${mb(v.peak_extra_disk_bytes)}. Whole run ${r.total_seconds} s.`,
  )
  return lines.join('\n')
}

function markdownOldForm(
  r: Head & Awaited<ReturnType<typeof runOldForm>> & { total_seconds: number },
): string {
  const m = r.migration
  const v = r.vacuum
  return [
    heading(r),
    '',
    '### Before `tg db migrate`',
    '',
    ...sizeLines(r.size_old_form),
    '',
    `\`tg db migrate\`: ${n(m.rows)} rows in ${m.seconds} s, ${n(m.rows_per_s)} rows/s; all done: ${m.all_done}, old-form rows left: ${m.old_form_rows_left}, attachment rows: ${n(m.attachments)}; peak WAL ${mb(m.peak_wal_bytes)}, peak extra disk ${mb(m.peak_extra_disk_bytes)}.`,
    '',
    '### After `tg db migrate`',
    '',
    ...sizeLines(r.size_after_migration),
    '',
    `\`tg db vacuum\` ${v.seconds} s, ${mb(v.bytes_before)} → ${mb(v.bytes_after)} (${n(r.size_after_vacuum.bytes_per_message)} B per message), peak extra disk ${mb(v.peak_extra_disk_bytes)}. Whole run ${r.total_seconds} s.`,
  ].join('\n')
}
