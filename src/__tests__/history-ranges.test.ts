/**
 * Tests for the ranges of a chat the cache holds without gaps
 * (src/db/history-ranges.ts)
 */
import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  createHistoryRanges,
  type HistoryRange,
  type HistoryRanges,
  type PageBounds,
} from '../db/history-ranges'
import { createMessagesCache } from '../db/messages-cache'
import { initCacheSchema } from '../db/schema'
import { initSyncSchema } from '../db/sync-schema'

const CHAT_ID = -1001234567890
const OTHER_CHAT_ID = 10

describe('HistoryRanges', () => {
  let db: Database
  let ranges: HistoryRanges

  beforeEach(() => {
    db = new Database(':memory:')
    initCacheSchema(db)
    initSyncSchema(db)
    ranges = createHistoryRanges(db)
  })

  afterEach(() => {
    db.close()
  })

  function stored(chatId = CHAT_ID): HistoryRange[] {
    return db
      .query(
        'SELECT low, high FROM history_ranges WHERE chat_id = ? ORDER BY low',
      )
      .all(chatId) as HistoryRange[]
  }

  function cacheMessage(messageId: number) {
    createMessagesCache(db).upsert({
      chat_id: CHAT_ID,
      message_id: messageId,
      message_type: 'text',
      date: 1_760_000_000 + messageId,
      raw_json: '{}',
    })
  }

  describe('add', () => {
    it.each<[string, HistoryRange[], HistoryRange[]]>([
      [
        'keeps apart ranges with a gap',
        [
          { low: 1, high: 5 },
          { low: 7, high: 9 },
        ],
        [
          { low: 1, high: 5 },
          { low: 7, high: 9 },
        ],
      ],
      [
        'merges touching ranges',
        [
          { low: 1, high: 5 },
          { low: 6, high: 9 },
        ],
        [{ low: 1, high: 9 }],
      ],
      [
        'merges overlapping ranges',
        [
          { low: 1, high: 5 },
          { low: 3, high: 9 },
        ],
        [{ low: 1, high: 9 }],
      ],
      [
        'keeps a range inside another',
        [
          { low: 1, high: 9 },
          { low: 3, high: 5 },
        ],
        [{ low: 1, high: 9 }],
      ],
      [
        'bridges ranges on both sides',
        [
          { low: 1, high: 3 },
          { low: 7, high: 9 },
          { low: 4, high: 6 },
        ],
        [{ low: 1, high: 9 }],
      ],
      [
        'ignores empty and invalid ranges',
        [
          { low: 5, high: 4 },
          { low: 0, high: 3 },
          { low: Number.POSITIVE_INFINITY, high: 8 },
        ],
        [],
      ],
    ])('%s', (_name, added, expected) => {
      for (const range of added) ranges.add(CHAT_ID, range)

      expect(stored()).toEqual(expected)
    })

    it('keeps chats apart', () => {
      ranges.add(CHAT_ID, { low: 1, high: 5 })
      ranges.add(OTHER_CHAT_ID, { low: 6, high: 9 })

      expect(stored(CHAT_ID)).toEqual([{ low: 1, high: 5 }])
      expect(stored(OTHER_CHAT_ID)).toEqual([{ low: 6, high: 9 }])
    })
  })

  describe('find', () => {
    it('returns the range that holds the message ID', () => {
      ranges.add(CHAT_ID, { low: 10, high: 20 })

      expect(ranges.find(CHAT_ID, 10)).toEqual({ low: 10, high: 20 })
      expect(ranges.find(CHAT_ID, 20)).toEqual({ low: 10, high: 20 })
      expect(ranges.find(CHAT_ID, 9)).toBeNull()
      expect(ranges.find(CHAT_ID, 21)).toBeNull()
      expect(ranges.find(OTHER_CHAT_ID, 15)).toBeNull()
    })
  })

  describe('recordPage', () => {
    it.each<[string, number[], PageBounds, HistoryRange[]]>([
      [
        'covers a page from its oldest to its newest message',
        [12, 10, 11],
        {},
        [{ low: 10, high: 12 }],
      ],
      [
        'counts empty messages, but not IDs of 0',
        [12, 0, 10],
        {},
        [{ low: 10, high: 12 }],
      ],
      [
        'covers from just above after',
        [8, 9],
        { after: 5 },
        [{ low: 6, high: 9 }],
      ],
      [
        'covers down to message 1 when the page reached the start',
        [4, 3],
        { reachedStart: true },
        [{ low: 1, high: 4 }],
      ],
      ['records nothing for an empty page', [], {}, []],
      ['records nothing above after without messages', [], { after: 5 }, []],
    ])('%s', (_name, ids, bounds, expected) => {
      ranges.recordPage(CHAT_ID, ids, bounds)

      expect(stored()).toEqual(expected)
    })

    it('covers up to before when a cached message proves nothing new lands below it', () => {
      // Private chats share one ID sequence per account, so pages have gaps
      cacheMessage(40)
      ranges.add(CHAT_ID, { low: 40, high: 45 })

      ranges.recordPage(CHAT_ID, [21, 17], { before: 40 })
      ranges.recordPage(CHAT_ID, [], { before: 17, reachedStart: true })

      expect(stored()).toEqual([{ low: 1, high: 45 }])
    })

    it('stops at the newest message below before when nothing is cached from it', () => {
      // A new message could still get an ID between 21 and 40
      ranges.recordPage(CHAT_ID, [21, 17], { before: 40 })
      ranges.recordPage(CHAT_ID, [], { before: 40, reachedStart: true })

      expect(stored()).toEqual([{ low: 17, high: 21 }])
    })
  })
})
