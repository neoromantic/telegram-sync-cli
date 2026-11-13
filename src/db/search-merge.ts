/**
 * Keep the search index merged (#149, #142). FTS5 keeps its index as
 * segments (b-trees) on levels and merges them now and then. By default it
 * does so inside the write that adds a segment, and a merge step copies the
 * whole entry list of a word, so a write could hold the lock for hundreds of
 * ms. A deleted or re-indexed message leaves its old entries in their
 * segment until that segment merges, and FTS5 merges only a level of four
 * segments: after the one-off re-index of names (#93) a level could keep
 * three segments whose entries were all deleted, which doubled the index
 * and made asking it about one message take milliseconds instead of
 * microseconds (docs/search.md).
 *
 * So writes never merge (FTS5's `automerge` 0), and the background
 * migration runners (the daemon and `tg db migrate`) merge in short steps
 * instead, with FTS5's 'merge' command, in one of two modes:
 *
 * - 'rest', after the writes of a tick: a level of two segments merges
 *   (`usermerge`), so the index keeps few segments and each question to it
 *   stays cheap. Once a tenth of its entries are deleted, every segment
 *   merges into one, which drops them.
 * - 'bulk', between the batches of a re-index: only a level of four. A
 *   re-index deletes every entry it rewrites, and merging at each second
 *   segment rewrote the index many times over; these merges only keep a
 *   level from reaching 16 segments, when FTS5 merges it inside a write
 *   (`crisismerge`). 'rest' cleans up after it.
 *
 * FTS5's own merge of a level with many deleted entries (`deletemerge`)
 * stays off: on a level whose entries are all deleted a step writes nothing,
 * and a step ends only once it has written its pages, so one step read the
 * whole level, 1.3 s on a 1M-message cache. Merging every segment into one
 * writes the entries that stay as it goes.
 */
import type { Database } from 'bun:sqlite'

import type { BatchLimits } from './background-migrations'

/**
 * Pages FTS5 writes per 'merge' step, a few ms on a 1M-message cache. A
 * step ends only between two words, after the word's whole entry list, so
 * the longest steps (a common word) take tens of ms whatever this is.
 */
const MERGE_STEP_PAGES = 16

export type SearchMergeMode = 'rest' | 'bulk'

/** The segments on one level that have it merged, per mode (`usermerge`) */
const LEVEL_SEGMENTS: Record<SearchMergeMode, number> = { rest: 2, bulk: 4 }

/** The share of deleted entries that has 'rest' merge every segment into one */
const DELETED_SHARE = 0.1

/** FTS5 keeps the list of segments in this row of message_search_data */
const STRUCTURE_ROWID = 10

const SET_OPTION =
  'INSERT INTO message_search(message_search, rank) VALUES(?, ?)'

function readOption(db: Database, option: string): unknown {
  const row = db
    .query('SELECT v FROM message_search_config WHERE k = ?')
    .get(option) as { v: unknown } | null
  return row?.v
}

/**
 * Stop merges inside writes, once per cache: a cache that has `automerge` 0
 * is only read. Only contentless-delete tables (SQLite 3.43+) know
 * `deletemerge`; caches from 0.9.0 to 0.11.1 have it at 0 already (#141).
 */
export function configureSearchMerges(
  db: Database,
  contentless: boolean,
): void {
  if (readOption(db, 'automerge') === 0) return
  const set = db.query(SET_OPTION)
  set.run('usermerge', LEVEL_SEGMENTS.rest)
  if (contentless) set.run('deletemerge', 0)
  // Last: a cache that has it is done
  set.run('automerge', 0)
}

/**
 * The list of segments when the last merge of a mode found nothing to do,
 * per connection. The list changes with every write to the index, so while
 * it stays the same there is nothing to merge in that mode, and checking
 * costs one read.
 */
const merged = new WeakMap<
  Database,
  { mode: SearchMergeMode; structure: Uint8Array }
>()

/** FTS5 writes this row when it creates the table */
function readStructure(db: Database): Uint8Array {
  const row = db
    .query('SELECT block FROM message_search_data WHERE id = ?')
    .get(STRUCTURE_ROWID) as { block: Uint8Array }
  return row.block
}

/** A varint as SQLite writes it: 7 bits a byte, big end first, the 9th byte whole */
function readVarint(bytes: Uint8Array, at: number): [number, number] {
  let value = 0
  for (let i = 0; i < 8; i++) {
    const byte = bytes[at + i] ?? 0
    value = value * 128 + (byte & 0x7f)
    if (byte < 0x80) return [value, at + i + 1]
  }
  return [value * 256 + (bytes[at + 8] ?? 0), at + 9]
}

/**
 * The share of deleted entries in the index, from FTS5's structure record
 * (fts5_index.c): a 4-byte cookie and, in the version that counts deleted
 * entries (FF 00 00 01, written once a contentless-delete index has rows),
 * varints: levels, segments, writes, then per level its merge state and
 * segment count, and per segment its ID, first and last page, two origin
 * counters, tombstone pages, deleted entries and entries. 0 for another
 * version.
 */
function deletedShare(structure: Uint8Array): number {
  const counted = [0xff, 0, 0, 1].every((byte, i) => structure[4 + i] === byte)
  if (!counted) return 0
  let at = 8
  const next = () => {
    const [value, end] = readVarint(structure, at)
    at = end
    return value
  }
  const levels = next()
  next() // segments
  next() // writes
  let entries = 0
  let deleted = 0
  for (let level = 0; level < levels; level++) {
    next() // segments in a merge in progress
    const segments = next()
    for (let segment = 0; segment < segments; segment++) {
      for (let field = 0; field < 6; field++) next()
      deleted += next()
      entries += next()
    }
  }
  return entries > 0 ? deleted / entries : 0
}

/** Whether the index may have segments to merge in `mode`; only reads */
export function isSearchMergeDue(
  db: Database,
  mode: SearchMergeMode = 'rest',
): boolean {
  const last = merged.get(db)
  if (last?.mode !== mode) return true
  return !Buffer.from(readStructure(db)).equals(last.structure)
}

export interface MergeBatchResult {
  /** 'merge' steps that did work */
  steps: number
  /** Whether nothing is left to merge */
  finished: boolean
}

/**
 * Merge in one write transaction: 'merge' steps until FTS5 finds nothing
 * to merge, and none started after `maxMs`. FTS5 says a step did nothing
 * when it changed fewer than 2 rows. In 'rest', a tenth of the entries
 * deleted then starts a merge of every segment into one (a negative
 * 'merge'), which the next steps go on with. A stop between batches loses
 * nothing: FTS5 records a merge in progress and the next step continues it.
 */
export function runSearchMergeBatch(
  db: Database,
  limits: Pick<BatchLimits, 'maxMs' | 'now'>,
  mode: SearchMergeMode = 'rest',
): MergeBatchResult {
  const now = limits.now ?? Date.now
  const merge = db.query(
    `INSERT INTO message_search(message_search, rank) VALUES('merge', ?)`,
  )
  const changes = db.query('SELECT total_changes() AS n')
  const totalChanges = () => (changes.get() as { n: number }).n

  return db
    .transaction((): MergeBatchResult => {
      if (readOption(db, 'usermerge') !== LEVEL_SEGMENTS[mode]) {
        db.query(SET_OPTION).run('usermerge', LEVEL_SEGMENTS[mode])
      }
      const started = now()
      let steps = 0
      let mergeAll = mode === 'rest'
      for (;;) {
        const before = totalChanges()
        merge.run(MERGE_STEP_PAGES)
        if (totalChanges() - before < 2) {
          const structure = readStructure(db)
          if (!mergeAll || deletedShare(structure) < DELETED_SHARE) {
            merged.set(db, { mode, structure })
            return { steps, finished: true }
          }
          mergeAll = false
          merge.run(-MERGE_STEP_PAGES)
        }
        steps += 1
        if (now() - started >= limits.maxMs) return { steps, finished: false }
      }
    })
    .immediate()
}
