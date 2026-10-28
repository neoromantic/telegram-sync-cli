/**
 * The file a cached message holds, read from its raw TL message. It reads
 * every form raw_json takes: Long values as mtcute Long objects,
 * `{ low, high, unsigned }`, decimal strings or numbers; byte arrays as
 * base64 strings or objects with a key per byte, which it never reads.
 */
import { classifyDocument } from './message-type'

export type AttachmentKind =
  | 'photo'
  | 'video'
  | 'round'
  | 'animation'
  | 'voice'
  | 'audio'
  | 'sticker'
  | 'document'

/** message: the message's own media; webpage: the file of its link preview */
export type AttachmentSource = 'message' | 'webpage'

/** The file of a message, as every CLI item prints it */
export interface AttachmentInfo {
  kind: AttachmentKind
  source: AttachmentSource
  /** The name the sender gave the file (documents only) */
  fileName: string | null
  /** The document's MIME type; image/jpeg for a photo */
  mimeType: string | null
  /** Bytes; for a photo, its largest size */
  size: number | null
  /** Seconds (video, round, animation, voice, audio) */
  duration: number | null
  width: number | null
  height: number | null
  /** Telegram's unique file ID: the same for the same file in any chat */
  uniqueFileId: string
  /** Album ID as a decimal string: messages sent as one album share it */
  groupedId: string | null
}

/** A preview (thumbnail) of a photo or document */
export interface MediaThumb {
  type: string
  width: number
  height: number
  /** The preview's own size in bytes */
  size: number
  uniqueFileId: string
}

type RawObject = Record<string, unknown>

function asObject(value: unknown): RawObject | null {
  return typeof value === 'object' && value !== null
    ? (value as RawObject)
    : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function attributesOf(doc: RawObject): RawObject[] {
  return Array.isArray(doc.attributes)
    ? doc.attributes.filter(
        (attr): attr is RawObject => asObject(attr) !== null,
      )
    : []
}

/** A TL Long in any form raw_json holds, as a decimal string */
function longToDecimal(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : null
  }
  if (typeof value === 'string') {
    return /^-?\d+$/.test(value) ? BigInt(value).toString() : null
  }
  const long = asObject(value)
  if (
    long &&
    typeof long.low === 'number' &&
    typeof long.high === 'number' &&
    Number.isInteger(long.low) &&
    Number.isInteger(long.high)
  ) {
    const bits = (BigInt(long.high) << 32n) | BigInt(long.low >>> 0)
    return (
      long.unsigned === true
        ? BigInt.asUintN(64, bits)
        : BigInt.asIntN(64, bits)
    ).toString()
  }
  return null
}

function longToNumber(value: unknown): number | null {
  const decimal = longToDecimal(value)
  if (decimal === null) return null
  const parsed = Number(decimal)
  return Number.isSafeInteger(parsed) ? parsed : null
}

/** Telegram's run-length encoding: each run of zero bytes becomes 0, count */
function rleEncode(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  let zeros = 0
  for (const byte of bytes) {
    if (byte === 0) {
      zeros += 1
      continue
    }
    if (zeros > 0) {
      out.push(0, zeros)
      zeros = 0
    }
    out.push(byte)
  }
  if (zeros > 0) out.push(0, zeros)
  return Uint8Array.from(out)
}

/**
 * Telegram's unique file ID, as mtcute's `uniqueFileId` gives it: type 2
 * with the document ID for a document, type 1 with the photo or document ID
 * and the size type for a photo or a preview
 */
export function uniqueFileIdOf(
  type: 1 | 2,
  id: bigint,
  thumbType?: string,
): string {
  const bytes = new Uint8Array(thumbType === undefined ? 12 : 13)
  const view = new DataView(bytes.buffer)
  view.setInt32(0, type, true)
  view.setBigInt64(4, BigInt.asIntN(64, id), true)
  if (thumbType !== undefined) {
    // mtcute writes the animated avatar type 'u' as '\0'
    const code = thumbType === 'u' ? 0 : thumbType.charCodeAt(0)
    bytes[12] = code === 97 ? 0 : code === 99 ? 1 : (code + 5) & 0xff
  }
  return rleEncode(bytes).toBase64({ alphabet: 'base64url', omitPadding: true })
}

/** A message from any form raw_json and the writers take */
function toMessage(input: unknown): RawObject | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  const message = asObject(value)
  if (!message) return null
  if (message._ === 'message' || message._ === 'updateShortSentMessage') {
    return message
  }
  // The abstract sync worker's message: no `_`, read as a message
  if (
    message._ === undefined &&
    typeof message.id === 'number' &&
    typeof message.date === 'number'
  ) {
    return message
  }
  return null
}

type PickedMedia =
  | { file: 'photo'; raw: RawObject; source: AttachmentSource }
  | { file: 'document'; raw: RawObject; source: AttachmentSource }

/** The photo or document a message holds, as mtcute picks its media */
function pickMedia(message: RawObject): PickedMedia | null {
  const media = asObject(message.media)
  if (!media) return null

  switch (media._) {
    case 'messageMediaPhoto': {
      const photo = asObject(media.photo)
      return photo?._ === 'photo'
        ? { file: 'photo', raw: photo, source: 'message' }
        : null
    }
    case 'messageMediaDocument': {
      const doc = asObject(media.document)
      return doc?._ === 'document'
        ? { file: 'document', raw: doc, source: 'message' }
        : null
    }
    case 'messageMediaWebPage': {
      const webpage = asObject(media.webpage)
      if (webpage?._ !== 'webPage') return null
      const doc = asObject(webpage.document)
      if (doc?._ === 'document') {
        return { file: 'document', raw: doc, source: 'webpage' }
      }
      const photo = asObject(webpage.photo)
      if (photo?._ === 'photo') {
        return { file: 'photo', raw: photo, source: 'webpage' }
      }
      return null
    }
    default:
      return null
  }
}

interface PhotoSize {
  type: string
  width: number | null
  height: number | null
  size: number | null
  progressive: boolean
}

/** The photoSize and photoSizeProgressive entries of a size list */
function plainSizes(sizes: unknown): PhotoSize[] {
  if (!Array.isArray(sizes)) return []
  const result: PhotoSize[] = []
  for (const entry of sizes) {
    const size = asObject(entry)
    const type = str(size?.type)
    if (!size || !type) continue
    if (size._ === 'photoSize') {
      result.push({
        type,
        width: num(size.w),
        height: num(size.h),
        size: num(size.size),
        progressive: false,
      })
    } else if (size._ === 'photoSizeProgressive') {
      const parts = Array.isArray(size.sizes)
        ? size.sizes.filter((part): part is number => num(part) !== null)
        : []
      result.push({
        type,
        width: num(size.w),
        height: num(size.h),
        size: parts.length > 0 ? Math.max(...parts) : null,
        progressive: true,
      })
    }
  }
  return result
}

/**
 * The size mtcute's Photo downloads: the progressive size if any, else the
 * plain size with the most bytes
 */
function bestPhotoSize(photo: RawObject): PhotoSize | null {
  const sizes = plainSizes(photo.sizes)
  const progressive = sizes.find((size) => size.progressive)
  if (progressive) return progressive
  let best: PhotoSize | null = null
  for (const size of sizes) {
    if (!best || (size.size ?? 0) > (best.size ?? 0)) best = size
  }
  return best
}

function photoAttachment(
  photo: RawObject,
  source: AttachmentSource,
  groupedId: string | null,
): AttachmentInfo | null {
  const id = longToDecimal(photo.id)
  const best = bestPhotoSize(photo)
  if (id === null || !best) return null
  return {
    kind: 'photo',
    source,
    fileName: null,
    mimeType: 'image/jpeg',
    size: best.size,
    duration: null,
    width: best.width,
    height: best.height,
    uniqueFileId: uniqueFileIdOf(1, BigInt(id), best.type),
    groupedId,
  }
}

function documentKind(doc: RawObject): {
  kind: AttachmentKind
  dimensions: RawObject | null
  timed: RawObject | null
} {
  const attributes = attributesOf(doc)
  const { type, attr } = classifyDocument(doc)

  switch (type) {
    case 'sticker': {
      const size =
        attributes.find(
          (it) =>
            it._ === 'documentAttributeImageSize' ||
            it._ === 'documentAttributeVideo',
        ) ?? null
      return {
        kind: 'sticker',
        dimensions: size,
        timed: size?._ === 'documentAttributeVideo' ? size : null,
      }
    }
    case 'voice':
    case 'audio':
      return { kind: type, dimensions: null, timed: attr }
    case 'video': {
      if (attr?._ !== 'documentAttributeVideo') {
        // A GIF sent as an image
        return { kind: 'animation', dimensions: attr, timed: null }
      }
      const animated = attributes.some(
        (it) => it._ === 'documentAttributeAnimated',
      )
      return {
        kind: attr.roundMessage ? 'round' : animated ? 'animation' : 'video',
        dimensions: attr,
        timed: attr,
      }
    }
    default:
      return {
        kind: 'document',
        dimensions:
          attributes.find((it) => it._ === 'documentAttributeImageSize') ??
          null,
        timed: null,
      }
  }
}

function documentAttachment(
  doc: RawObject,
  source: AttachmentSource,
  groupedId: string | null,
): AttachmentInfo | null {
  const id = longToDecimal(doc.id)
  if (id === null) return null
  const { kind, dimensions, timed } = documentKind(doc)
  const fileName = attributesOf(doc).find(
    (attr) => attr._ === 'documentAttributeFilename',
  )?.fileName

  return {
    kind,
    source,
    fileName: str(fileName),
    mimeType: str(doc.mimeType),
    size: longToNumber(doc.size),
    duration: num(timed?.duration),
    width: num(dimensions?.w),
    height: num(dimensions?.h),
    uniqueFileId: uniqueFileIdOf(2, BigInt(id)),
    groupedId,
  }
}

/**
 * The file of a message: its photo or document, or the photo or document
 * of its link preview. Null for a message without one, and for anything
 * that isn't a message; never throws.
 */
export function extractAttachment(input: unknown): AttachmentInfo | null {
  const message = toMessage(input)
  if (!message) return null
  const media = pickMedia(message)
  if (!media) return null

  const groupedId = longToDecimal(message.groupedId)
  return media.file === 'photo'
    ? photoAttachment(media.raw, media.source, groupedId)
    : documentAttachment(media.raw, media.source, groupedId)
}

function area(size: PhotoSize): number {
  return (size.width ?? 0) * (size.height ?? 0)
}

/**
 * The preview `tg media download --thumb` fetches: for a photo its `m` size
 * (320 px) or else its smallest plain size, for a document its largest
 * thumbnail. Stripped, cached, path and video sizes are never used.
 */
export function pickThumb(input: unknown): MediaThumb | null {
  const message = toMessage(input)
  const media = message ? pickMedia(message) : null
  if (!media) return null
  const ownerId = longToDecimal(media.raw.id)
  if (ownerId === null) return null

  let chosen: PhotoSize | undefined
  if (media.file === 'photo') {
    const sizes = plainSizes(media.raw.sizes).filter((s) => !s.progressive)
    chosen =
      sizes.find((size) => size.type === 'm') ??
      sizes.reduce<PhotoSize | undefined>(
        (min, size) => (!min || area(size) < area(min) ? size : min),
        undefined,
      )
  } else {
    chosen = plainSizes(media.raw.thumbs).reduce<PhotoSize | undefined>(
      (max, size) => (!max || area(size) > area(max) ? size : max),
      undefined,
    )
  }
  if (
    !chosen ||
    chosen.width === null ||
    chosen.height === null ||
    chosen.size === null
  ) {
    return null
  }

  return {
    type: chosen.type,
    width: chosen.width,
    height: chosen.height,
    size: chosen.size,
    uniqueFileId: uniqueFileIdOf(1, BigInt(ownerId), chosen.type),
  }
}

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'application/x-tgsticker': 'tgs',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/zip': 'zip',
}

/**
 * A name for a file the sender gave no name: `photo.jpg`, `voice.ogg`,
 * `file.pdf` for a plain document; `.bin` for a MIME type it doesn't know
 */
export function attachmentDefaultFileName(info: AttachmentInfo): string {
  if (info.kind === 'photo') return 'photo.jpg'
  const stem = info.kind === 'document' ? 'file' : info.kind
  const extension = (info.mimeType && EXTENSION_BY_MIME[info.mimeType]) || 'bin'
  return `${stem}.${extension}`
}
