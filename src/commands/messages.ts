import { defineCommand } from 'citty'

import { getMessageCommand } from './messages/get'
import { listMessagesCommand } from './messages/list'
import { readMessagesCommand } from './messages/read'
import { searchMessagesCommand } from './messages/search'
import { unreadMessagesCommand } from './messages/unread'
import { waitMessagesCommand, watchMessagesCommand } from './messages/wait'

/**
 * Messages subcommand group
 */
export const messagesCommand = defineCommand({
  meta: {
    name: 'messages',
    description:
      'Read chat history, search cached messages, wait for new ones, list unread ones and mark them read',
  },
  subCommands: {
    list: listMessagesCommand,
    get: getMessageCommand,
    search: searchMessagesCommand,
    wait: waitMessagesCommand,
    watch: watchMessagesCommand,
    unread: unreadMessagesCommand,
    read: readMessagesCommand,
  },
})

export {
  getMessageCommand,
  listMessagesCommand,
  readMessagesCommand,
  searchMessagesCommand,
  unreadMessagesCommand,
  waitMessagesCommand,
  watchMessagesCommand,
}
