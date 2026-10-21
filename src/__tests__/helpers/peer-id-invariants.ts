/**
 * One peer ID format in the whole cache (#18): every table that holds a
 * chat holds its marked ID, the format mtcute reads.
 */
import type { Database } from 'bun:sqlite'
import { expect } from 'bun:test'
import { parseMarkedPeerId } from '@mtcute/bun'

/** What a chats_cache type may be as an mtcute peer type */
const KINDS_BY_TYPE: Record<string, string[]> = {
  private: ['user'],
  // A community is stored as 'group' but has a channel ID
  group: ['chat', 'channel'],
  supergroup: ['channel'],
  channel: ['channel'],
}

const MARKED_ID_COLUMNS = [
  ['messages_cache', 'chat_id'],
  ['chat_sync_state', 'chat_id'],
  ['sync_jobs', 'chat_id'],
  ['history_ranges', 'chat_id'],
] as const

function peerType(id: number): string {
  try {
    return parseMarkedPeerId(id)[0]
  } catch {
    return `invalid peer ID ${id}`
  }
}

/**
 * Fail with every row that breaks the format: a chats_cache row whose ID
 * doesn't fit its type (a bare group or channel ID, say), or a chat ID in
 * another table that mtcute can't parse
 */
export function assertPeerIdInvariants(db: Database): void {
  const violations: string[] = []

  const chats = db.query('SELECT chat_id, type FROM chats_cache').all() as {
    chat_id: string
    type: string
  }[]
  for (const { chat_id, type } of chats) {
    const kind = peerType(Number(chat_id))
    if (!KINDS_BY_TYPE[type]?.includes(kind)) {
      violations.push(`chats_cache ${chat_id} (${type}) is ${kind}`)
    }
  }

  for (const [table, column] of MARKED_ID_COLUMNS) {
    const ids = db
      .query(`SELECT DISTINCT ${column} AS id FROM ${table}`)
      .all() as { id: number }[]
    for (const { id } of ids) {
      const kind = peerType(id)
      if (!['user', 'chat', 'channel'].includes(kind)) {
        violations.push(`${table}.${column} ${id} is ${kind}`)
      }
    }
  }

  expect(violations).toEqual([])
}
