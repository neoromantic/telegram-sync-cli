import { defineCommand } from 'citty'

import { getMessageCommand } from './messages/get'
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
    get: getMessageCommand,
    search: searchMessagesCommand,
  },
})

export { getMessageCommand, listMessagesCommand, searchMessagesCommand }
