import { defineCommand } from 'citty'

import { getChatCommand } from './chats/get'
import { listChatsCommand } from './chats/list'
import { searchChatsCommand } from './chats/search'
import { syncChatCommand } from './chats/sync'

/**
 * Chats subcommand group
 */
export const chatsCommand = defineCommand({
  meta: {
    name: 'chats',
    description: 'Chat and dialog management commands',
  },
  subCommands: {
    list: listChatsCommand,
    search: searchChatsCommand,
    get: getChatCommand,
    sync: syncChatCommand,
  },
})

export { getChatCommand, listChatsCommand, searchChatsCommand, syncChatCommand }
