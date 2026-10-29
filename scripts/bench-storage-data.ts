/**
 * Made-up Telegram data for the storage benchmark (scripts/bench-storage.ts):
 * users, chats and raw TL messages shaped as mtcute's reader gives them
 * (every flag a boolean, Long IDs, byte fields as Uint8Array). Every value
 * comes from the seed, and each message from (seed, chat, index) alone, so
 * any page can be generated again byte for byte. No real people, chats or
 * data: names and words are built from syllables, links use example.com.
 */
import { Long } from '@mtcute/bun'

/** The account's own user ID */
export const SELF_ID = 5_550_000

/** The newest message is one day before this Unix time (Sept. 2026) */
const END_DATE = 1_790_000_000
const FIVE_YEARS = 5 * 365 * 24 * 3600

// ── Deterministic randomness ────────────────────────────────────────────

/** mulberry32: a small, fast 32-bit PRNG */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A 32-bit hash of a few integers, to seed one message's PRNG */
function hash(...parts: number[]): number {
  let h = 2_166_136_261
  for (const part of parts) {
    h = Math.imul(h ^ (part & 0xffff), 16_777_619)
    h = Math.imul(h ^ (part >>> 16), 16_777_619)
  }
  return h >>> 0
}

type Rand = () => number

function int(r: Rand, min: number, max: number): number {
  return min + Math.floor(r() * (max - min + 1))
}

function pick<T>(r: Rand, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)] as T
}

function bytes(r: Rand, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = Math.floor(r() * 256)
  return out
}

function long(r: Rand): Long {
  return Long.fromBits(
    Math.floor(r() * 4_294_967_296) | 0,
    Math.floor(r() * 2_147_483_648) | 0,
  )
}

/** Cumulative weights of a Zipf distribution over `n` ranks */
function zipfCdf(n: number, s: number): Float64Array {
  const cdf = new Float64Array(n)
  let sum = 0
  for (let k = 0; k < n; k++) {
    sum += 1 / (k + 1) ** s
    cdf[k] = sum
  }
  for (let k = 0; k < n; k++) cdf[k] = (cdf[k] as number) / sum
  return cdf
}

function sampleCdf(cdf: Float64Array, u: number): number {
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((cdf[mid] as number) < u) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ── Vocabulary ──────────────────────────────────────────────────────────

const LATIN = [
  'ka',
  'lo',
  'mi',
  'ren',
  'sa',
  'tu',
  'vel',
  'no',
  'pi',
  'dar',
  'es',
  'il',
  'ox',
  'um',
  'bri',
  'sto',
  'fen',
  'gar',
  'hu',
  'jo',
  'qua',
  'zen',
  'wil',
  'yor',
  'cas',
  'lin',
  'mor',
  'pet',
  'rus',
  'tal',
] as const
const CYRILLIC = [
  'ра',
  'но',
  'ве',
  'ли',
  'ко',
  'сто',
  'мир',
  'дан',
  'по',
  'ты',
  'жу',
  'ле',
  'бо',
  'ска',
  'тре',
  'зо',
  'фи',
  'гро',
  'чу',
  'ша',
  'вол',
  'ден',
  'кру',
  'лап',
  'мех',
  'нор',
  'пыл',
  'сен',
  'тум',
  'хор',
] as const
/** Endings a Cyrillic stem takes, so `stem*` finds several word forms */
const ENDINGS = ['', 'а', 'ы', 'у', 'ом', 'ой', 'ами', 'ах'] as const
const EMOJI = ['👍', '❤', '🔥', '😂', '🎉', '🤔'] as const

export interface Word {
  stem: string
  cyrillic: boolean
}

/** Pseudo-words, most frequent first; half Latin, half Cyrillic */
export function buildVocabulary(seed: number, size: number): Word[] {
  const r = rng(hash(seed, 1))
  const seen = new Set<string>()
  const words: Word[] = []
  while (words.length < size) {
    const cyrillic = r() < 0.5
    const syllables = cyrillic ? CYRILLIC : LATIN
    let stem = ''
    const count = int(r, 2, 4)
    for (let i = 0; i < count; i++) stem += pick(r, syllables)
    if (seen.has(stem)) continue
    seen.add(stem)
    words.push({ stem, cyrillic })
  }
  return words
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

// ── Users and chats ─────────────────────────────────────────────────────

export type ChatKind = 'private' | 'group' | 'supergroup' | 'channel'

export interface BenchUser {
  id: number
  raw: Record<string, unknown>
}

export interface BenchChat {
  index: number
  kind: ChatKind
  /** The marked peer ID, as messages_cache stores it */
  chatId: number
  /** The bare ID in peerUser/peerChat/peerChannel */
  peerId: number
  title: string
  /** Messages this chat gets in the generated history */
  size: number
  /** Message IDs: firstId + i + floor(i / 37), one gap every 37 messages */
  firstId: number
  startDate: number
  endDate: number
  /** Users who write here, most active first; the peer in a private chat */
  members: number[]
  raw: Record<string, unknown> | null
}

function makeUser(seed: number, index: number, vocab: Word[]) {
  const r = rng(hash(seed, 2, index))
  const id = SELF_ID + 1 + index
  const first = capitalize(pick(r, vocab.slice(0, 2000)).stem)
  const last =
    r() < 0.7 ? capitalize(pick(r, vocab.slice(0, 5000)).stem) : undefined
  const username = r() < 0.5 ? `user_${id.toString(36)}` : undefined
  return {
    id,
    raw: {
      _: 'user',
      self: false,
      contact: r() < 0.3,
      mutualContact: false,
      deleted: false,
      bot: false,
      botChatHistory: false,
      botNochats: false,
      verified: false,
      restricted: false,
      min: false,
      botInlineGeo: false,
      support: false,
      scam: false,
      applyMinPhoto: true,
      fake: false,
      botAttachMenu: false,
      premium: r() < 0.1,
      attachMenuEnabled: false,
      botCanEdit: false,
      closeFriend: false,
      storiesHidden: false,
      storiesUnavailable: true,
      contactRequirePremium: false,
      botBusiness: false,
      botHasMainApp: false,
      botForumView: false,
      botForumCanManageTopics: false,
      botCanManageBots: false,
      botGuestchat: false,
      botGuard: false,
      id,
      accessHash: long(r),
      firstName: first,
      lastName: last,
      username,
      photo:
        r() < 0.6
          ? {
              _: 'userProfilePhoto',
              hasVideo: false,
              personal: false,
              photoId: long(r),
              strippedThumb: bytes(r, int(r, 80, 160)),
              dcId: int(r, 1, 5),
            }
          : undefined,
      status: { _: 'userStatusRecently', byMe: false },
    },
  }
}

export interface Dataset {
  seed: number
  vocab: Word[]
  wordCdf: Float64Array
  users: BenchUser[]
  chats: BenchChat[]
}

/**
 * The account's users and chats, and how many messages each chat gets:
 * chat sizes follow a Zipf curve, so a few chats are big and most are small
 */
export function buildDataset(
  seed: number,
  messages: number,
  vocabularySize = 30_000,
): Dataset {
  const vocab = buildVocabulary(seed, vocabularySize)
  const wordCdf = zipfCdf(vocab.length, 1)
  const userCount = Math.min(20_000, Math.max(50, Math.round(messages / 500)))
  const chatCount = Math.min(10_000, Math.max(30, Math.round(messages / 1000)))
  const users = Array.from({ length: userCount }, (_, i) =>
    makeUser(seed, i, vocab),
  )

  const weights = Array.from({ length: chatCount }, (_, k) => 1 / (k + 1))
  const total = weights.reduce((a, b) => a + b, 0)
  const sizes = weights.map((w) =>
    Math.max(1, Math.floor((messages * w) / total)),
  )
  sizes[0] = (sizes[0] as number) + messages - sizes.reduce((a, b) => a + b, 0)

  const r = rng(hash(seed, 3))
  // Private chats and basic groups share the account's message ID counter
  let sharedId = 1
  let privateUser = 0
  const chats: BenchChat[] = sizes.map((size, index) => {
    const fixed: ChatKind[] = ['supergroup', 'channel', 'private', 'group']
    const roll = r()
    const kind: ChatKind =
      fixed[index] ??
      (roll < 0.6
        ? 'private'
        : roll < 0.7
          ? 'group'
          : roll < 0.85
            ? 'supergroup'
            : 'channel')
    const span = Math.floor(FIVE_YEARS * (0.05 + 0.95 * r()))
    const endDate = END_DATE - 86_400 - int(r, 0, 30 * 86_400)
    const startDate = endDate - span
    const id = (n: number) => n + Math.floor(n / 37)
    const title = Array.from({ length: int(r, 1, 3) }, () =>
      capitalize(pick(r, vocab.slice(0, 3000)).stem),
    ).join(' ')

    let firstId = 1
    if (kind === 'private' || kind === 'group') {
      firstId = sharedId
      sharedId += id(size) + 1
    }

    if (kind === 'private') {
      const user = users[privateUser++ % users.length] as BenchUser
      return {
        index,
        kind,
        chatId: user.id,
        peerId: user.id,
        title: [user.raw.firstName, user.raw.lastName]
          .filter(Boolean)
          .join(' '),
        size,
        firstId,
        startDate,
        endDate,
        members: [user.id],
        raw: null,
      }
    }

    const memberCount = Math.min(users.length, int(r, 5, 200))
    const offset = int(r, 0, users.length - 1)
    const members = Array.from(
      { length: memberCount },
      (_, i) => (users[(offset + i * 7) % users.length] as BenchUser).id,
    )
    if (kind === 'group') {
      const peerId = 4000 + index
      return {
        index,
        kind,
        chatId: -peerId,
        peerId,
        title,
        size,
        firstId,
        startDate,
        endDate,
        members,
        raw: {
          _: 'chat',
          creator: false,
          left: false,
          deactivated: false,
          callActive: false,
          callNotEmpty: false,
          noforwards: false,
          id: peerId,
          title,
          photo: { _: 'chatPhotoEmpty' },
          participantsCount: memberCount,
          date: startDate,
          version: int(r, 1, 40),
        },
      }
    }

    const peerId = 1_234_000_000 + index
    const broadcast = kind === 'channel'
    return {
      index,
      kind,
      chatId: -1_000_000_000_000 - peerId,
      peerId,
      title,
      size,
      firstId,
      startDate,
      endDate,
      members,
      raw: {
        _: 'channel',
        creator: false,
        left: false,
        broadcast,
        verified: false,
        megagroup: !broadcast,
        restricted: false,
        signatures: false,
        min: false,
        scam: false,
        hasLink: false,
        hasGeo: false,
        slowmodeEnabled: false,
        callActive: false,
        callNotEmpty: false,
        fake: false,
        gigagroup: false,
        noforwards: false,
        joinToSend: false,
        joinRequest: false,
        forum: false,
        storiesHidden: false,
        storiesHiddenMin: false,
        storiesUnavailable: true,
        signatureProfiles: false,
        autotranslation: false,
        broadcastMessagesAllowed: false,
        monoforum: false,
        forumTabs: false,
        inNews: false,
        id: peerId,
        accessHash: long(r),
        title,
        username: r() < 0.5 ? `chan_${peerId.toString(36)}` : undefined,
        photo: { _: 'chatPhotoEmpty' },
        date: startDate,
        participantsCount: broadcast ? int(r, 100, 50_000) : int(r, 20, 5000),
      },
    }
  })

  return { seed, vocab, wordCdf, users, chats }
}

/** The message ID of a chat's i-th message, oldest first */
export function messageIdAt(chat: BenchChat, i: number): number {
  return chat.firstId + i + Math.floor(i / 37)
}

// ── Messages ────────────────────────────────────────────────────────────

function peerOf(chat: BenchChat) {
  if (chat.kind === 'private') return { _: 'peerUser', userId: chat.peerId }
  if (chat.kind === 'group') return { _: 'peerChat', chatId: chat.peerId }
  return { _: 'peerChannel', channelId: chat.peerId }
}

function words(r: Rand, data: Dataset, count: number): string {
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    const word = data.vocab[sampleCdf(data.wordCdf, r())] as Word
    out.push(word.cyrillic ? word.stem + pick(r, ENDINGS) : word.stem)
  }
  return out.join(' ')
}

/** 3–40 words, most messages short */
function messageText(r: Rand, data: Dataset): string {
  return words(r, data, 3 + Math.floor(37 * r() ** 2))
}

function strippedSize(r: Rand, min: number, max: number) {
  return {
    _: 'photoStrippedSize',
    type: 'i',
    bytes: bytes(r, int(r, min, max)),
  }
}

function photo(r: Rand, date: number) {
  const w = pick(r, [1280, 1080, 960, 1600])
  const h = Math.round(w * pick(r, [0.75, 1, 1.33, 0.5625]))
  return {
    _: 'photo',
    hasStickers: false,
    id: long(r),
    accessHash: long(r),
    fileReference: bytes(r, 30),
    date,
    sizes: [
      strippedSize(r, 400, 900),
      {
        _: 'photoSize',
        type: 'm',
        w: 320,
        h: Math.round((320 * h) / w),
        size: int(r, 9000, 25_000),
      },
      {
        _: 'photoSize',
        type: 'x',
        w: 800,
        h: Math.round((800 * h) / w),
        size: int(r, 40_000, 90_000),
      },
      {
        _: 'photoSizeProgressive',
        type: 'y',
        w,
        h,
        sizes: [
          int(r, 8000, 12_000),
          int(r, 20_000, 40_000),
          int(r, 60_000, 90_000),
          int(r, 100_000, 150_000),
          int(r, 150_000, 300_000),
        ],
      },
    ],
    videoSizes: undefined,
    dcId: int(r, 1, 5),
  }
}

function document(
  r: Rand,
  date: number,
  mimeType: string,
  size: number,
  attributes: unknown[],
  thumbs?: unknown[],
) {
  return {
    _: 'document',
    id: long(r),
    accessHash: long(r),
    fileReference: bytes(r, 30),
    date,
    mimeType,
    size,
    thumbs,
    videoThumbs: undefined,
    dcId: int(r, 1, 5),
    attributes,
  }
}

function mediaDocument(
  doc: unknown,
  flags: { video?: boolean; voice?: boolean } = {},
) {
  return {
    _: 'messageMediaDocument',
    nopremium: false,
    spoiler: false,
    video: flags.video ?? false,
    round: false,
    voice: flags.voice ?? false,
    document: doc,
  }
}

type MediaKind =
  | 'photo'
  | 'video'
  | 'voice'
  | 'document'
  | 'sticker'
  | 'webpage'

/** ~10% photos, then videos, voice messages, files, stickers and link previews */
function mediaKind(r: Rand, chat: BenchChat): MediaKind | null {
  const roll = r()
  if (roll < 0.1) return 'photo'
  if (roll < 0.115) return 'video'
  if (roll < 0.13) return chat.kind === 'channel' ? null : 'voice'
  if (roll < 0.15) return 'document'
  if (roll < 0.16) return chat.kind === 'channel' ? null : 'sticker'
  if (roll < 0.18) return 'webpage'
  return null
}

function buildMedia(r: Rand, data: Dataset, kind: MediaKind, date: number) {
  switch (kind) {
    case 'photo':
      return {
        _: 'messageMediaPhoto',
        spoiler: false,
        livePhoto: false,
        photo: photo(r, date),
      }
    case 'video': {
      const w = pick(r, [1280, 720, 1920])
      const h = Math.round((w * 9) / 16)
      return mediaDocument(
        document(
          r,
          date,
          'video/mp4',
          int(r, 500_000, 80_000_000),
          [
            {
              _: 'documentAttributeVideo',
              roundMessage: false,
              supportsStreaming: true,
              nosound: false,
              duration: int(r, 3, 600) + r(),
              w,
              h,
              preloadPrefixSize: int(r, 50_000, 200_000),
            },
            {
              _: 'documentAttributeFilename',
              fileName: `${words(r, data, 2).replace(/ /g, '_')}.mp4`,
            },
          ],
          [
            strippedSize(r, 300, 700),
            {
              _: 'photoSize',
              type: 'm',
              w: 320,
              h: 180,
              size: int(r, 5000, 15_000),
            },
          ],
        ),
        { video: true },
      )
    }
    case 'voice':
      return mediaDocument(
        document(r, date, 'audio/ogg', int(r, 5000, 900_000), [
          {
            _: 'documentAttributeAudio',
            voice: true,
            duration: int(r, 1, 180),
            waveform: bytes(r, 63),
          },
        ]),
        { voice: true },
      )
    case 'document': {
      const ext = pick(r, ['pdf', 'zip', 'docx', 'xlsx', 'txt'] as const)
      const mime = {
        pdf: 'application/pdf',
        zip: 'application/zip',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        txt: 'text/plain',
      }[ext]
      return mediaDocument(
        document(r, date, mime, int(r, 2000, 20_000_000), [
          {
            _: 'documentAttributeFilename',
            fileName: `${words(r, data, int(r, 1, 3)).replace(/ /g, '_')}.${ext}`,
          },
        ]),
      )
    }
    case 'sticker':
      return mediaDocument(
        document(
          r,
          date,
          'image/webp',
          int(r, 10_000, 60_000),
          [
            { _: 'documentAttributeImageSize', w: 512, h: 512 },
            {
              _: 'documentAttributeSticker',
              mask: false,
              alt: pick(r, EMOJI),
              stickerset: {
                _: 'inputStickerSetID',
                id: long(r),
                accessHash: long(r),
              },
            },
          ],
          [
            {
              _: 'photoSize',
              type: 'm',
              w: 128,
              h: 128,
              size: int(r, 3000, 8000),
            },
          ],
        ),
      )
    case 'webpage': {
      const path = words(r, data, 2).replace(/ /g, '-')
      return {
        _: 'messageMediaWebPage',
        forceLargeMedia: false,
        forceSmallMedia: false,
        manual: false,
        safe: false,
        webpage: {
          _: 'webPage',
          hasLargeMedia: false,
          videoCoverPhoto: false,
          id: long(r),
          url: `https://example.com/${path}`,
          displayUrl: `example.com/${path}`,
          hash: int(r, 0, 2_000_000_000),
          type: 'article',
          siteName: 'Example',
          title: capitalize(words(r, data, int(r, 3, 8))),
          description: capitalize(words(r, data, int(r, 10, 30))),
        },
      }
    }
  }
}

/**
 * A chat's i-th message (oldest first), from (seed, chat, i) alone: the
 * same arguments give the same object, so a page fetched again is unchanged
 */
export function generateMessage(
  data: Dataset,
  chat: BenchChat,
  i: number,
): Record<string, unknown> {
  const r = rng(hash(data.seed, 4, chat.index, i))
  const id = messageIdAt(chat, i)
  const span = chat.endDate - chat.startDate
  const date = chat.startDate + Math.floor((i * span) / Math.max(1, chat.size))
  const peerId = peerOf(chat)
  const isChannel = chat.kind === 'channel'
  const outgoing = !isChannel && r() < (chat.kind === 'private' ? 0.4 : 0.08)
  // The most active members write most of the messages
  const sender = outgoing
    ? SELF_ID
    : (chat.members[Math.floor(chat.members.length * r() ** 2)] as number)
  const fromId = isChannel ? undefined : { _: 'peerUser', userId: sender }

  if (chat.kind !== 'private' && !isChannel && r() < 0.005) {
    return {
      _: 'messageService',
      out: outgoing,
      mentioned: false,
      mediaUnread: false,
      reactionsArePossible: true,
      silent: false,
      post: false,
      legacy: false,
      id,
      fromId,
      peerId,
      date,
      action: { _: 'messageActionChatAddUser', users: [pick(r, chat.members)] },
    }
  }

  const kind = mediaKind(r, chat)
  let text = ''
  if (kind === null || kind === 'webpage') text = messageText(r, data)
  else if (
    kind === 'photo'
      ? r() < 0.4
      : kind !== 'voice' && kind !== 'sticker' && r() < 0.3
  ) {
    text = messageText(r, data)
  }
  const media = kind ? buildMedia(r, data, kind, date) : undefined
  if (kind === 'webpage') {
    const page = (media as { webpage: { url: string } }).webpage
    text = `${text} ${page.url}`
  }

  const replyTo =
    i > 0 && r() < 0.1
      ? {
          _: 'messageReplyHeader',
          replyToScheduled: false,
          forumTopic: false,
          quote: false,
          replyToEphemeral: false,
          replyToMsgId: messageIdAt(chat, Math.max(0, i - int(r, 1, 50))),
        }
      : undefined
  const fwdFrom =
    r() < 0.03
      ? {
          _: 'messageFwdHeader',
          imported: false,
          savedOut: false,
          fromId: { _: 'peerUser', userId: pick(r, data.users).id },
          date: date - int(r, 60, 86_400 * 30),
        }
      : undefined
  const entities =
    text && r() < 0.08
      ? [
          {
            _: 'messageEntityBold',
            offset: 0,
            length: Math.min(text.length, int(r, 3, 12)),
          },
        ]
      : undefined
  const reactions =
    chat.kind !== 'private' && r() < 0.05
      ? {
          _: 'messageReactions',
          min: false,
          canSeeList: chat.kind !== 'channel',
          reactionsAsTags: false,
          results: [
            {
              _: 'reactionCount',
              reaction: { _: 'reactionEmoji', emoticon: pick(r, EMOJI) },
              count: int(r, 1, 40),
            },
          ],
        }
      : undefined
  const edited = r() < 0.05

  return {
    _: 'message',
    out: outgoing,
    mentioned: false,
    mediaUnread: false,
    silent: false,
    post: isChannel,
    fromScheduled: false,
    legacy: false,
    editHide: false,
    pinned: r() < 0.001,
    noforwards: false,
    invertMedia: false,
    offline: false,
    videoProcessingPending: false,
    paidSuggestedPostStars: false,
    paidSuggestedPostTon: false,
    id,
    fromId,
    peerId,
    fwdFrom,
    replyTo,
    date,
    message: text,
    media,
    entities,
    views: isChannel ? int(r, 50, 50_000) : undefined,
    forwards: isChannel ? int(r, 0, 500) : undefined,
    editDate: edited ? date + int(r, 10, 3600) : undefined,
    reactions,
  }
}

/** A chat's message for a new live update, above its generated history */
export function generateLiveMessage(
  data: Dataset,
  chat: BenchChat,
  n: number,
): Record<string, unknown> {
  const message = generateMessage(data, chat, chat.size + n)
  return { ...message, date: chat.endDate + 60 * (n + 1) }
}

/** Raw users of the senders on a page, as getHistory returns them */
export function pageUsers(
  data: Dataset,
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const ids = new Set<number>()
  for (const message of messages) {
    const from = message.fromId as { userId?: number } | undefined
    if (from?.userId && from.userId !== SELF_ID) ids.add(from.userId)
  }
  return [...ids].map((id) => (data.users[id - SELF_ID - 1] as BenchUser).raw)
}

/** The vocabulary's Latin or Cyrillic words, most frequent first */
export function wordsOf(data: Dataset, cyrillic: boolean): string[] {
  return data.vocab
    .filter((word) => word.cyrillic === cyrillic)
    .map((word) => word.stem)
}
