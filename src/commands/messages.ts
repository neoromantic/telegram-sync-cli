import { defineCommand } from 'citty'

import { getMessageCommand } from './messages/get'
import { listMessagesCommand } from './messages/list'
import { searchMessagesCommand } from './messages/search'
import { waitMessagesCommand, watchMessagesCommand } from './messages/wait'

/**
 * Messages subcommand group
 */
export const messagesCommand = defineCommand({
  meta: {
    name: 'messages',
    description:
      'Read chat history, search cached messages and wait for new ones',
  },
  subCommands: {
    list: listMessagesCommand,
    get: getMessageCommand,
    search: searchMessagesCommand,
    wait: waitMessagesCommand,
    watch: watchMessagesCommand,
  },
})

export {
  getMessageCommand,
  listMessagesCommand,
  searchMessagesCommand,
  waitMessagesCommand,
  watchMessagesCommand,
}
