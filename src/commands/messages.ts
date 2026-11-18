import { defineCommand } from 'citty'

import { getMessageCommand } from './messages/get'
import { listMessagesCommand } from './messages/list'
import { pinMessageCommand, unpinMessageCommand } from './messages/pin'
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
      'Read chat history, search cached messages, wait for new ones, list unread ones, mark them read, and pin or unpin a message',
  },
  subCommands: {
    list: listMessagesCommand,
    get: getMessageCommand,
    search: searchMessagesCommand,
    wait: waitMessagesCommand,
    watch: watchMessagesCommand,
    unread: unreadMessagesCommand,
    read: readMessagesCommand,
    pin: pinMessageCommand,
    unpin: unpinMessageCommand,
  },
})

export {
  getMessageCommand,
  listMessagesCommand,
  pinMessageCommand,
  readMessagesCommand,
  searchMessagesCommand,
  unpinMessageCommand,
  unreadMessagesCommand,
  waitMessagesCommand,
  watchMessagesCommand,
}
