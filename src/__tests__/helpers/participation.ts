/**
 * Group participation for tests whose groups are only fixtures: the account
 * sent a message in each group just now, so the groups take new messages
 * (src/db/group-participation.ts)
 */
import type { Database } from 'bun:sqlite'
import { createGroupParticipation } from '../../db/group-participation'

export function takePartIn(db: Database, ...chatIds: number[]): void {
  const participation = createGroupParticipation(db)
  const now = Math.floor(Date.now() / 1000)
  for (const chatId of chatIds) participation.observeOwnMessage(chatId, now)
}
