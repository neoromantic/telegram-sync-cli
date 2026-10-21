/**
 * The move of a 0.2.0 cache to marked peer IDs (#18), run by initSyncSchema
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createChatSyncStateService } from '../db/chat-sync-state'
import { type CachedChatInput, createChatsCache } from '../db/chats-cache'
import { createMessagesSearch } from '../db/messages-search'
import { PEER_ID_USER_VERSION } from '../db/peer-id-migration'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import { initSyncSchema, SyncJobType, SyncPriority } from '../db/sync-schema'
import {
  initLegacySchema,
  LEGACY,
  legacyChatRow,
  seedLegacyCache,
} from './helpers/legacy-cache'
import { assertPeerIdInvariants } from './helpers/peer-id-invariants'

function userVersion(db: Database): number {
  return (db.query('PRAGMA user_version').get() as { user_version: number })
    .user_version
}

function chatIds(db: Database): Record<string, string> {
  const rows = db
    .query('SELECT chat_id, title FROM chats_cache ORDER BY title')
    .all() as { chat_id: string; title: string }[]
  return Object.fromEntries(rows.map((row) => [row.title, row.chat_id]))
}

function dump(db: Database, table: string): unknown[] {
  return db.query(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all()
}

function totalChanges(db: Database): number {
  return (db.query('SELECT total_changes() AS n').get() as { n: number }).n
}

function chatRow(
  chat: Pick<CachedChatInput, 'chat_id' | 'type' | 'title'> &
    Partial<CachedChatInput>,
): CachedChatInput {
  return {
    username: null,
    member_count: null,
    access_hash: null,
    is_creator: 0,
    is_admin: 0,
    last_message_id: null,
    last_message_at: null,
    fetched_at: 1_000,
    raw_json: '{}',
    ...chat,
  }
}

describe('peer ID migration', () => {
  let db: Database

  beforeEach(() => {
    db = new Database(':memory:')
    initLegacySchema(db)
  })

  afterEach(() => {
    db.close()
  })

  it('gives groups, supergroups and channels their marked IDs', () => {
    seedLegacyCache(db)

    initSyncSchema(db)

    expect(chatIds(db)).toEqual({
      'Alice Able': '10',
      'Book Club': '-4242',
      'Example News': '-1002222222222',
      'Team Chat': '-1001234567890',
    })
    expect(userVersion(db)).toBe(PEER_ID_USER_VERSION)
    assertPeerIdInvariants(db)
  })

  it('takes the ID from raw_json, so a community stored as a group gets a channel ID', () => {
    const chats = createChatsCache(db)
    chats.upsertMany([
      legacyChatRow({ kind: 'supergroup', id: 1111111111, title: 'Dialog' }),
      chatRow({
        chat_id: '5555555555',
        type: 'group',
        title: 'Community',
        raw_json: JSON.stringify({
          _: 'community',
          id: 5555555555,
          title: 'Community',
        }),
      }),
      chatRow({ chat_id: '4001', type: 'group', title: 'No raw' }),
      chatRow({ chat_id: '4002', type: 'channel', title: 'Channel, no raw' }),
      // raw_json that names another chat doesn't count
      chatRow({
        chat_id: '4003',
        type: 'group',
        title: 'Wrong raw',
        raw_json: JSON.stringify({ _: 'channel', id: 9 }),
      }),
      chatRow({
        chat_id: '4004',
        type: 'group',
        title: 'Malformed raw',
        raw_json: '{"_":',
      }),
      chatRow({
        chat_id: '4005',
        type: 'channel',
        title: 'User raw',
        raw_json: JSON.stringify({ _: 'user', id: 4005 }),
      }),
    ])

    initSyncSchema(db)

    expect(chatIds(db)).toEqual({
      'Channel, no raw': '-1000000004002',
      Community: '-1005555555555',
      Dialog: '-1001111111111',
      'Malformed raw': '-4004',
      'No raw': '-4001',
      'User raw': '-1000000004005',
      'Wrong raw': '-4003',
    })
    assertPeerIdInvariants(db)
  })

  for (const [newer, older] of [
    ['bare', 'marked'],
    ['marked', 'bare'],
  ] as const) {
    it(`keeps the ${newer} row when it is newer than the ${older} one`, () => {
      const rows = {
        bare: chatRow({
          chat_id: '1234567890',
          type: 'supergroup',
          title: 'Bare row',
        }),
        marked: chatRow({
          chat_id: '-1001234567890',
          type: 'supergroup',
          title: 'Marked row',
        }),
      }
      createChatsCache(db).upsertMany([
        { ...rows[newer], fetched_at: 2_000, access_hash: null },
        { ...rows[older], fetched_at: 1_000, access_hash: '777' },
      ])

      initSyncSchema(db)

      const left = db.query('SELECT * FROM chats_cache').all()
      expect(left).toEqual([
        expect.objectContaining({
          chat_id: '-1001234567890',
          title: newer === 'bare' ? 'Bare row' : 'Marked row',
          fetched_at: 2_000,
          access_hash: '777',
        }),
      ])
    })
  }

  it('leaves the other tables byte-identical', () => {
    seedLegacyCache(db)
    createChatSyncStateService(db).upsert({
      chat_id: LEGACY.teamChat.marked,
      chat_type: 'supergroup',
      member_count: 12,
      sync_priority: SyncPriority.High,
      sync_enabled: true,
    })
    createSyncJobsService(db).create({
      chat_id: LEGACY.bookClub.marked,
      job_type: SyncJobType.InitialLoad,
      priority: SyncPriority.High,
    })
    const tables = [
      'messages_cache',
      'chat_sync_state',
      'sync_jobs',
      'history_ranges',
      'users_cache',
    ]
    const before = tables.map((table) => dump(db, table))

    initSyncSchema(db)

    expect(tables.map((table) => dump(db, table))).toEqual(before)
    assertPeerIdInvariants(db)
  })

  it('changes nothing when it runs on a migrated cache', () => {
    seedLegacyCache(db)
    initSyncSchema(db)
    const snapshot = () => ({
      schema: db.query('SELECT * FROM sqlite_master ORDER BY name').all(),
      rows: [
        'chats_cache',
        'messages_cache',
        'message_search',
        'search_meta',
        'users_cache',
        'history_ranges',
      ].map((table) => dump(db, table)),
      userVersion: userVersion(db),
    })
    const before = snapshot()
    const changes = totalChanges(db)

    initSyncSchema(db)

    expect(snapshot()).toEqual(before)
    expect(totalChanges(db)).toBe(changes)
  })

  it('rolls everything back when one update fails, and retries on the next open', () => {
    seedLegacyCache(db)
    db.run(`
      CREATE TRIGGER fail_rekey BEFORE UPDATE OF chat_id ON chats_cache
      WHEN old.chat_id = '4242'
      BEGIN SELECT RAISE(ABORT, 'disk full'); END
    `)
    const chatsBefore = dump(db, 'chats_cache')
    const searchBefore = dump(db, 'message_search')

    expect(() => initSyncSchema(db)).toThrow('disk full')

    expect(dump(db, 'chats_cache')).toEqual(chatsBefore)
    expect(dump(db, 'message_search')).toEqual(searchBefore)
    expect(userVersion(db)).toBe(0)

    db.run('DROP TRIGGER fail_rekey')
    initSyncSchema(db)

    expect(userVersion(db)).toBe(PEER_ID_USER_VERSION)
    assertPeerIdInvariants(db)
  })

  it('indexes group and channel titles for search, without a new index version', () => {
    seedLegacyCache(db)
    const search = createMessagesSearch(db)
    // 0.2.0 indexed no title for a group or channel
    expect(search.search('Team Chat')).toEqual([])

    initSyncSchema(db)

    expect(
      search.search('Team Chat').map((row) => [row.chat_id, row.message_id]),
    ).toEqual([
      [LEGACY.teamChat.marked, 2],
      [LEGACY.teamChat.marked, 1],
    ])
    expect(
      search.search('Book Club').map((row) => [row.chat_id, row.chat_title]),
    ).toEqual([[LEGACY.bookClub.marked, 'Book Club']])
    expect(
      db
        .query(
          "SELECT value FROM search_meta WHERE key = 'search_index_version'",
        )
        .get(),
    ).toEqual({ value: '1' })
  })

  it('re-keys a bare row that an older daemon writes after the upgrade', () => {
    seedLegacyCache(db)
    initSyncSchema(db)

    // A 0.2.0 daemon still running caches a chat the old way
    createChatsCache(db).upsert(
      legacyChatRow({ kind: 'channel', id: 3333333333, title: 'Late News' }),
    )
    initSyncSchema(db)

    expect(chatIds(db)['Late News']).toBe('-1003333333333')
    assertPeerIdInvariants(db)
  })
})

describe('peer ID migration on a shared file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tg-peer-id-migration-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('lets two connections both open a 0.2.0 cache', () => {
    const path = join(dir, 'cache.db')
    const seed = new Database(path)
    initLegacySchema(seed)
    seedLegacyCache(seed)
    seed.close()

    const daemon = new Database(path)
    const cli = new Database(path)
    try {
      openCache(daemon)
      openCache(cli)

      expect(userVersion(cli)).toBe(PEER_ID_USER_VERSION)
      expect(chatIds(daemon)['Team Chat']).toBe('-1001234567890')
      assertPeerIdInvariants(cli)
    } finally {
      daemon.close()
      cli.close()
    }
  })
})

/** What getCacheDb runs when it opens the file */
function openCache(db: Database): void {
  initCacheSchema(db)
  initSyncSchema(db)
}
