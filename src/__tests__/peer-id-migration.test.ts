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
import { createMessagesCache } from '../db/messages-cache'
import { createMessagesSearch } from '../db/messages-search'
import { migratePeerIds, PEER_ID_USER_VERSION } from '../db/peer-id-migration'
import { initCacheSchema } from '../db/schema'
import { createSyncJobsService } from '../db/sync-jobs'
import {
  initSyncSchema,
  rebuildMessageSearchIndex,
  SyncJobType,
  SyncPriority,
} from '../db/sync-schema'
import { createUsersCache } from '../db/users-cache'
import {
  initLegacySchema,
  LEGACY,
  legacyChatRow,
  legacyMessageRow,
  rawMessage,
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

function busyTimeout(db: Database): number {
  return (db.query('PRAGMA busy_timeout').get() as { timeout: number }).timeout
}

/** from_id and forward_from_id of every cached message, by chat and ID */
function senderIds(db: Database): unknown[] {
  return db
    .query(
      'SELECT chat_id, message_id, from_id, forward_from_id FROM messages_cache ORDER BY chat_id, message_id',
    )
    .all()
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

  it('leaves chat IDs in the other tables byte-identical', () => {
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
      'chat_sync_state',
      'sync_jobs',
      'history_ranges',
      'users_cache',
    ]
    // Only the sender and forward columns of messages_cache change
    const messages = () =>
      dump(db, 'messages_cache').map((row) => {
        const { from_id, forward_from_id, ...rest } = row as Record<
          string,
          unknown
        >
        return rest
      })
    const before = tables.map((table) => dump(db, table))
    const messagesBefore = messages()

    initSyncSchema(db)

    expect(tables.map((table) => dump(db, table))).toEqual(before)
    expect(messages()).toEqual(messagesBefore)
    assertPeerIdInvariants(db)
  })

  it('gives group and channel senders and forward sources their marked IDs', () => {
    const team = { _: 'peerChannel', channelId: LEGACY.teamChat.id } as const
    const alice = { _: 'peerUser', userId: 10 } as const
    const channel = { _: 'peerChannel', channelId: 333 } as const
    const group = { _: 'peerChat', chatId: 222 } as const
    const rows = [
      legacyMessageRow(rawMessage(team, 1, 'as a channel', channel)),
      legacyMessageRow(rawMessage(team, 2, 'as a group', group)),
      legacyMessageRow(rawMessage(team, 3, 'forwarded', alice, channel)),
      legacyMessageRow(rawMessage(team, 4, 'forwarded too', alice, group)),
      legacyMessageRow(rawMessage(team, 5, 'from a user', alice, alice)),
      // A live message already had the marked sender
      {
        ...legacyMessageRow(rawMessage(team, 6, 'live', channel)),
        from_id: -1000000000333,
      },
      {
        ...legacyMessageRow(rawMessage(team, 7, 'no raw')),
        from_id: 333,
        raw_json: '{}',
      },
      {
        ...legacyMessageRow(rawMessage(team, 8, 'bad raw')),
        from_id: 333,
        forward_from_id: 222,
        raw_json: '{"fromId":',
      },
      // A stored ID that isn't the bare ID of the peer raw_json names stays
      {
        ...legacyMessageRow(rawMessage(team, 9, 'other', channel, channel)),
        from_id: 444,
        forward_from_id: 444,
      },
      {
        ...legacyMessageRow(rawMessage(team, 10, 'other too', group, group)),
        from_id: 444,
        forward_from_id: 444,
      },
    ]
    createMessagesCache(db).upsertBatch(rows)

    expect(() => initSyncSchema(db)).not.toThrow()

    const ids = db
      .query(
        'SELECT message_id, from_id, forward_from_id FROM messages_cache ORDER BY message_id',
      )
      .all()
      .map((row) => {
        const { message_id, from_id, forward_from_id } = row as Record<
          string,
          number | null
        >
        return [message_id, from_id, forward_from_id]
      })
    expect(ids).toEqual([
      [1, -1000000000333, null],
      [2, -222, null],
      [3, 10, -1000000000333],
      [4, 10, -222],
      [5, 10, 10],
      [6, -1000000000333, null],
      [7, 333, null],
      [8, 333, 222],
      [9, 444, 444],
      [10, 444, 444],
    ])
    expect(userVersion(db)).toBe(PEER_ID_USER_VERSION)
  })

  it('stops indexing a channel sender under the user with its bare ID', () => {
    seedLegacyCache(db)
    // A user whose ID equals the bare ID of the channel that posts
    createUsersCache(db).upsert({
      user_id: String(LEGACY.senderChannel.id),
      first_name: 'Zed',
      last_name: 'Zeller',
      fetched_at: 1_000,
      raw_json: '{}',
    })
    db.run('UPDATE messages_cache SET text = text')
    const search = createMessagesSearch(db)
    expect(search.search('Zeller')).toHaveLength(1)

    initSyncSchema(db)

    expect(search.search('Zeller')).toEqual([])
    expect(search.search('weekly digest')[0]).toMatchObject({
      from_id: LEGACY.senderChannel.marked,
      sender_first_name: null,
    })
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

  it('rolls back the re-key and the index rebuild when the last step, the sender update, fails', () => {
    seedLegacyCache(db)
    db.run(`
      CREATE TRIGGER fail_senders BEFORE UPDATE OF from_id ON messages_cache
      BEGIN SELECT RAISE(ABORT, 'disk full'); END
    `)
    const tables = ['chats_cache', 'message_search', 'messages_cache']
    const before = tables.map((table) => dump(db, table))
    const sendersBefore = senderIds(db)

    expect(() => initSyncSchema(db)).toThrow('disk full')

    expect(tables.map((table) => dump(db, table))).toEqual(before)
    expect(senderIds(db)).toEqual(sendersBefore)
    expect(userVersion(db)).toBe(0)

    db.run('DROP TRIGGER fail_senders')
    initSyncSchema(db)

    expect(userVersion(db)).toBe(PEER_ID_USER_VERSION)
    expect(chatIds(db)['Team Chat']).toBe(String(LEGACY.teamChat.marked))
    expect(
      db
        .query(
          "SELECT from_id FROM messages_cache WHERE text = 'weekly digest is out'",
        )
        .get(),
    ).toEqual({ from_id: LEGACY.senderChannel.marked })
    assertPeerIdInvariants(db)
  })

  it('rolls back the re-key when the search index rebuild fails', () => {
    seedLegacyCache(db)
    const chatsBefore = dump(db, 'chats_cache')
    const sendersBefore = senderIds(db)

    expect(() =>
      migratePeerIds(db, () => {
        throw new Error('disk full')
      }),
    ).toThrow('disk full')

    expect(dump(db, 'chats_cache')).toEqual(chatsBefore)
    expect(chatIds(db)['Team Chat']).toBe(String(LEGACY.teamChat.id))
    expect(senderIds(db)).toEqual(sendersBefore)
    expect(userVersion(db)).toBe(0)
  })

  it('waits up to 60 s for the write lock while it migrates, then restores the busy timeout', () => {
    seedLegacyCache(db)
    expect(busyTimeout(db)).toBe(5000)
    const seen: number[] = []

    expect(() =>
      migratePeerIds(db, (conn) => {
        seen.push(busyTimeout(conn))
        throw new Error('disk full')
      }),
    ).toThrow('disk full')
    expect(seen).toEqual([60_000])
    expect(busyTimeout(db)).toBe(5000)

    migratePeerIds(db, (conn) => {
      seen.push(busyTimeout(conn))
      rebuildMessageSearchIndex(conn)
    })
    expect(seen).toEqual([60_000, 60_000])
    expect(busyTimeout(db)).toBe(5000)
    expect(userVersion(db)).toBe(PEER_ID_USER_VERSION)
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

  it('lets a second connection open a cache the first one moved to marked IDs', () => {
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
