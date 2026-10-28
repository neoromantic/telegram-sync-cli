/**
 * The message_type every writer stores: live updates read it from mtcute's
 * high-level media, history pages and `tg send` from the raw TL message,
 * and both give the same value for the same message.
 */

/** mtcute's media.type → the cached message_type */
export const MESSAGE_TYPE_BY_MEDIA_TYPE: Record<string, string> = {
  photo: 'photo',
  video: 'video',
  document: 'document',
  sticker: 'sticker',
  voice: 'voice',
  audio: 'audio',
  poll: 'poll',
  contact: 'contact',
  location: 'location',
  live_location: 'location',
  venue: 'venue',
  game: 'game',
  invoice: 'invoice',
  webpage: 'webpage',
  dice: 'dice',
}

/** The cached message_type of a message whose media has this mtcute type */
export function messageTypeOfMediaType(
  type: string | undefined | null,
): string {
  return (type && MESSAGE_TYPE_BY_MEDIA_TYPE[type]) || 'unknown'
}

type RawObject = Record<string, unknown>

function asObject(value: unknown): RawObject | null {
  return typeof value === 'object' && value !== null
    ? (value as RawObject)
    : null
}

function attributesOf(doc: RawObject): RawObject[] {
  const attributes = doc.attributes
  if (!Array.isArray(attributes)) return []
  return attributes.filter((attr): attr is RawObject => asObject(attr) !== null)
}

/**
 * What mtcute's parseDocument makes of a raw document: a sticker or custom
 * emoji attribute makes a sticker; otherwise the first audio attribute
 * (voice or audio), video attribute, or image size of a GIF decides; else a
 * plain document. `attr` is the attribute that decided.
 */
export function classifyDocument(doc: RawObject): {
  type: 'sticker' | 'voice' | 'audio' | 'video' | 'document'
  attr: RawObject | null
} {
  const attributes = attributesOf(doc)
  const sticker = attributes.find(
    (attr) =>
      attr._ === 'documentAttributeSticker' ||
      attr._ === 'documentAttributeCustomEmoji',
  )
  if (sticker) return { type: 'sticker', attr: sticker }

  for (const attr of attributes) {
    switch (attr._) {
      case 'documentAttributeAudio':
        return { type: attr.voice ? 'voice' : 'audio', attr }
      case 'documentAttributeVideo':
        return { type: 'video', attr }
      case 'documentAttributeImageSize':
        if (doc.mimeType === 'image/gif') return { type: 'video', attr }
        break
    }
  }
  return { type: 'document', attr: null }
}

/**
 * The mtcute media.type that `_messageMediaFromTl` gives this raw TL media,
 * or null where mtcute gives no media (unsupported media, a photo or file
 * that expired, a link preview still pending)
 */
export function rawMediaType(media: unknown): string | null {
  const m = asObject(media)
  if (!m) return null

  switch (m._) {
    case 'messageMediaPhoto':
      return asObject(m.photo)?._ === 'photo' ? 'photo' : null
    case 'messageMediaDice':
      return 'dice'
    case 'messageMediaContact':
      return 'contact'
    case 'messageMediaDocument': {
      const doc = asObject(m.document)
      return doc?._ === 'document' ? classifyDocument(doc).type : null
    }
    case 'messageMediaGeo':
      return asObject(m.geo)?._ === 'geoPoint' ? 'location' : null
    case 'messageMediaGeoLive':
      return asObject(m.geo)?._ === 'geoPoint' ? 'live_location' : null
    case 'messageMediaGame':
      return 'game'
    case 'messageMediaWebPage':
      return asObject(m.webpage)?._ === 'webPage' ? 'webpage' : null
    case 'messageMediaVenue':
      return 'venue'
    case 'messageMediaPoll':
      return 'poll'
    case 'messageMediaInvoice':
      return 'invoice'
    case 'messageMediaStory':
      return 'story'
    case 'messageMediaPaidMedia':
      return 'paid'
    case 'messageMediaToDo':
      return 'todo'
    default:
      return null
  }
}

/**
 * The message_type and has_media of a raw TL message, as a live update of
 * the same message stores them. A message object without `_` (the abstract
 * sync worker's) is read as a message; its media must be raw TL.
 */
export function resolveRawMessageType(message: unknown): {
  messageType: string
  hasMedia: boolean
} {
  const m = asObject(message)
  if (m?._ === 'messageService') {
    return { messageType: 'service', hasMedia: false }
  }

  const type = rawMediaType(m?.media)
  if (type === null) return { messageType: 'text', hasMedia: false }
  return { messageType: messageTypeOfMediaType(type), hasMedia: true }
}
