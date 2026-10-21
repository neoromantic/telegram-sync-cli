/**
 * A fake `messages.getHistory` for one chat, for sync worker tests.
 *
 * It follows the server's paging rules: results are newest first, `minId`
 * and `maxId` are exclusive bounds, `offsetId` starts the page at the first
 * message older than it, and `addOffset` shifts that start (negative values
 * move it towards newer messages).
 */
import type { TelegramClient } from '@mtcute/bun'

export interface GetHistoryRequest {
  _: string
  offsetId: number
  addOffset: number
  limit: number
  minId: number
  maxId: number
}

export function rawMessage(id: number) {
  return { _: 'message', id, date: 1_700_000_000 + id, message: `msg ${id}` }
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

export function createFakeHistory(initialIds: Iterable<number>) {
  const ids = new Set(initialIds)
  const requests: GetHistoryRequest[] = []

  const call = async (request: GetHistoryRequest) => {
    requests.push(request)
    const { offsetId, addOffset, limit, minId, maxId } = request

    const newestFirst = [...ids]
      .filter((id) => (!minId || id > minId) && (!maxId || id < maxId))
      .sort((a, b) => b - a)

    const olderIndex = newestFirst.findIndex((id) => id < offsetId)
    const start =
      offsetId > 0 ? (olderIndex === -1 ? newestFirst.length : olderIndex) : 0
    const from = Math.max(0, start + addOffset)
    const to = Math.max(0, start + addOffset + limit)

    return {
      _: 'messages.messagesSlice',
      count: newestFirst.length,
      messages: newestFirst.slice(from, to).map(rawMessage),
    }
  }

  return {
    client: { call } as unknown as TelegramClient,
    requests,
    add(...newIds: number[]) {
      for (const id of newIds) ids.add(id)
    },
  }
}
