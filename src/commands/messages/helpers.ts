import type { MessageSearchRow } from '../../db/messages-search'
import type { MessageSearchItem } from '../../types'

/** The JSON item for a message row, shared by every `tg messages` command */
export function messageRowToItem(row: MessageSearchRow): MessageSearchItem {
  return {
    chatId: row.chat_id,
    messageId: row.message_id,
    fromId: row.from_id,
    text: row.text,
    messageType: row.message_type,
    hasMedia: row.has_media === 1,
    mediaPath: row.media_path,
    isOutgoing: row.is_outgoing === 1,
    isEdited: row.is_edited === 1,
    isPinned: row.is_pinned === 1,
    isDeleted: row.is_deleted === 1,
    replyToId: row.reply_to_id,
    forwardFromId: row.forward_from_id,
    editDate: row.edit_date,
    date: row.date,
    chat: {
      id: row.chat_id,
      title: row.chat_title,
      username: row.chat_username,
      type: row.chat_type,
    },
    sender: {
      id: row.from_id,
      username: row.sender_username,
      firstName: row.sender_first_name,
      lastName: row.sender_last_name,
    },
  }
}
