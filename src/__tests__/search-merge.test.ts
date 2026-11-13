/**
 * The search index merges in the background, not inside writes (#149,
 * #142): writes pile up segments, a merge batch merges them and drops the
 * entries of deleted and re-indexed messages, and answers stay the same.
 */
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

import { runPendingMigrations } from '../db/background-migrations'
import { initCacheSchema } from '../db/schema'
import { isSearchMergeDue, runSearchMergeBatch } from '../db/search-merge'
import { initSyncSchema } from '../db/sync-schema'

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot']

function open(): Database {
  const db = new Database(':memory:')
  initCacheSchema(db)
  initSyncSchema(db)
  return db
}

/** Messages `from` to `to`, each write transaction `perWrite` of them */
function writeMessages(
  db: Database,
  to: number,
  perWrite: number,
  from = 1,
): void {
  const insert = db.query(`
    INSERT INTO messages_cache (chat_id, message_id, from_id, text, date, fetched_at, raw_json)
    VALUES (100, ?, 1, ?, ?, 0, '{}')
  `)
  for (let first = from; first <= to; first += perWrite) {
    db.transaction(() => {
      for (let id = first; id < first + perWrite && id <= to; id++) {
        insert.run(id, `${WORDS[id % WORDS.length]} ${WORDS[id % 4]}`, id)
      }
    })()
  }
}

/** Segments of the index: rows of message_search_data name theirs in the upper bits */
function segments(db: Database): number {
  return (
    db
      .query(
        'SELECT COUNT(DISTINCT id >> 37) AS n FROM message_search_data WHERE (id >> 37) BETWEEN 1 AND 65535',
      )
      .get() as { n: number }
  ).n
}

function indexBytes(db: Database): number {
  return (
    db
      .query('SELECT SUM(LENGTH(block)) AS n FROM message_search_data')
      .get() as { n: number }
  ).n
}

function matches(db: Database, word: string): number[] {
  return (
    db
      .query(
        'SELECT rowid FROM message_search WHERE message_search MATCH ? ORDER BY rowid',
      )
      .all(word) as { rowid: number }[]
  ).map((row) => row.rowid)
}

function mergeAll(db: Database): number {
  let batches = 0
  for (;;) {
    batches += 1
    if (runSearchMergeBatch(db, { maxMs: 1_000 }).finished) return batches
  }
}

describe('search index merges', () => {
  it('leave writes alone: segments pile up until a merge', () => {
    const db = open()
    // A segment per message: FTS5 itself merges only a level of 16 (crisismerge)
    writeMessages(db, 400, 10)
    expect(segments(db)).toBeGreaterThan(8)

    const before = WORDS.map((word) => matches(db, word))
    mergeAll(db)
    expect(segments(db)).toBeLessThan(4)
    expect(WORDS.map((word) => matches(db, word))).toEqual(before)
  })

  /** Re-index the messages from `from` to `to`, as search-reindex.ts does: delete, then insert */
  function reindex(db: Database, from: number, to: number): void {
    const rows = db
      .query(
        'SELECT rowid, text FROM messages_cache WHERE rowid BETWEEN ? AND ?',
      )
      .all(from, to) as { rowid: number; text: string }[]
    const remove = db.query('DELETE FROM message_search WHERE rowid = ?')
    const insert = db.query(
      'INSERT INTO message_search(rowid, text, sender, chat, files) VALUES (?, ?, ?, ?, ?)',
    )
    for (let i = 0; i < rows.length; i += 50) {
      db.transaction(() => {
        for (const row of rows.slice(i, i + 50)) {
          remove.run(row.rowid)
          insert.run(row.rowid, row.text, '1', '100', '')
        }
      })()
    }
  }

  /** Pages of deleted entries: their segment IDs are 65,536 up */
  function deletedPages(db: Database): number {
    return (
      db
        .query(
          'SELECT COUNT(*) AS n FROM message_search_data WHERE (id >> 37) >= 65536',
        )
        .get() as { n: number }
    ).n
  }

  it("drop a re-indexed message's old entries", () => {
    const db = open()
    writeMessages(db, 400, 400)
    mergeAll(db)
    const merged = indexBytes(db)

    reindex(db, 1, 400)
    expect(indexBytes(db)).toBeGreaterThan(1.5 * merged)
    expect(deletedPages(db)).toBeGreaterThan(0)

    const before = WORDS.map((word) => matches(db, word))
    mergeAll(db)
    expect(indexBytes(db)).toBeLessThan(1.2 * merged)
    expect(deletedPages(db)).toBe(0)
    expect(segments(db)).toBe(1)
    expect(WORDS.map((word) => matches(db, word))).toEqual(before)
  })

  it('leave a few deleted entries for later', () => {
    const db = open()
    writeMessages(db, 400, 400)
    mergeAll(db)
    // 5% of the entries deleted: under a tenth
    reindex(db, 1, 20)
    mergeAll(db)
    expect(deletedPages(db)).toBeGreaterThan(0)

    // 60 of the 460 entries now
    reindex(db, 21, 60)
    mergeAll(db)
    expect(deletedPages(db)).toBe(0)
  })

  it('stop FTS5 from merging inside writes on a new cache', () => {
    const options = open()
      .query(
        `SELECT k, v FROM message_search_config WHERE k IN ('automerge', 'deletemerge', 'usermerge') ORDER BY k`,
      )
      .all()
    expect(options).toEqual([
      { k: 'automerge', v: 0 },
      { k: 'deletemerge', v: 0 },
      { k: 'usermerge', v: 2 },
    ])
  })

  it('are due again only after a write', () => {
    const db = open()
    writeMessages(db, 100, 10)
    expect(isSearchMergeDue(db)).toBe(true)
    mergeAll(db)
    expect(isSearchMergeDue(db)).toBe(false)
    expect(runSearchMergeBatch(db, { maxMs: 1_000 })).toEqual({
      steps: 0,
      finished: true,
    })

    writeMessages(db, 101, 1, 101)
    expect(isSearchMergeDue(db)).toBe(true)
  })

  it('stop a batch at its time limit and go on in the next one', () => {
    const db = open()
    writeMessages(db, 2_000, 20)
    let clock = 0
    // Each step takes 10 ms on this clock
    const now = () => {
      clock += 10
      return clock
    }
    const first = runSearchMergeBatch(db, { maxMs: 10, now })
    expect(first).toEqual({ steps: 1, finished: false })
    expect(isSearchMergeDue(db)).toBe(true)

    expect(mergeAll(db)).toBeGreaterThan(0)
    expect(isSearchMergeDue(db)).toBe(false)
    expect(segments(db)).toBeLessThan(4)
  })

  it('merge only levels of four between the batches of a re-index, then the rest', () => {
    const db = open()
    // FTS5 writes a segment per message: each insert is its own statement
    writeMessages(db, 3, 3)
    expect(segments(db)).toBe(3)

    expect(runSearchMergeBatch(db, { maxMs: 1_000 }, 'bulk')).toEqual({
      steps: 0,
      finished: true,
    })
    expect(isSearchMergeDue(db, 'bulk')).toBe(false)
    expect(isSearchMergeDue(db, 'rest')).toBe(true)
    writeMessages(db, 4, 1, 4)
    expect(runSearchMergeBatch(db, { maxMs: 1_000 }, 'bulk').steps).toBe(1)
    expect(segments(db)).toBe(1)

    writeMessages(db, 6, 2, 5)
    expect(segments(db)).toBe(3)
    mergeAll(db)
    expect(segments(db)).toBe(1)
  })

  it('run after the background migrations, in the daemon and tg db migrate', async () => {
    const db = open()
    writeMessages(db, 400, 10)
    await runPendingMigrations(db)
    expect(isSearchMergeDue(db)).toBe(false)
    expect(segments(db)).toBeLessThan(4)
  })
})
