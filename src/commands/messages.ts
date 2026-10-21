import { defineCommand } from 'citty'

import { listMessagesCommand } from './messages/list'
import { searchMessagesCommand } from './messages/search'

/**
 * Messages subcommand group
 */
export const messagesCommand = defineCommand({
  meta: {
    name: 'messages',
    description: 'Read chat history and search cached messages',
  },
  subCommands: {
    list: listMessagesCommand,
    search: searchMessagesCommand,
  },
})

export { listMessagesCommand, searchMessagesCommand }
