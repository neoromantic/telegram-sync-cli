import type { Database } from "bun:sqlite";
import { createGroupParticipation } from "../db/group-participation";

export function takePartIn(db: Database, ...chatIds: number[]) {
  const participation = createGroupParticipation(db);
  const now = Math.floor(Date.now() / 1000);
  for (const chatId of chatIds) participation.observeOwnMessage(chatId, now);
}
