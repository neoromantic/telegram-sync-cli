/**
 * Tests for message parser utilities
 */
import { describe, expect, it } from 'bun:test'
import {
  determineMessageType,
  extractForwardFromId,
  extractPeerId,
  parseRawMessage,
  parseRawMessages,
  type RawMessage,
  type RawMessageFwdHeader,
  type RawPeer,
} from '../utils/message-parser'
import {
  pdfDocumentMessage,
  stickerMessage,
  videoMessage,
  voiceMessage,
  webpageMessage,
} from './helpers/media-messages'
import { photoMessage } from './helpers/photo-message'

describe('extractPeerId', () => {
  it('extracts userId from peerUser', () => {
    const peer: RawPeer = { _: 'peerUser', userId: 12345 }
    expect(extractPeerId(peer)).toBe(12345)
  })

  it('gives a basic group (peerChat) its marked ID', () => {
    const peer: RawPeer = { _: 'peerChat', chatId: 67890 }
    expect(extractPeerId(peer)).toBe(-67890)
  })

  it('gives a channel (peerChannel) its marked ID', () => {
    const peer: RawPeer = { _: 'peerChannel', channelId: 11111 }
    expect(extractPeerId(peer)).toBe(-1000000011111)
  })

  it('returns undefined for undefined peer', () => {
    expect(extractPeerId(undefined)).toBeUndefined()
  })
})

describe('extractForwardFromId', () => {
  it('extracts userId when forwarded from a user', () => {
    const fwdFrom: RawMessageFwdHeader = {
      _: 'messageFwdHeader',
      fromId: { _: 'peerUser', userId: 12345 },
      date: Date.now(),
    }
    expect(extractForwardFromId(fwdFrom)).toBe(12345)
  })

  it('gives a basic group (peerChat) source its marked ID', () => {
    const fwdFrom: RawMessageFwdHeader = {
      _: 'messageFwdHeader',
      fromId: { _: 'peerChat', chatId: 67890 },
      date: Date.now(),
    }
    expect(extractForwardFromId(fwdFrom)).toBe(-67890)
  })

  it('gives a channel source its marked ID', () => {
    const fwdFrom: RawMessageFwdHeader = {
      _: 'messageFwdHeader',
      fromId: { _: 'peerChannel', channelId: 11111 },
      date: Date.now(),
    }
    expect(extractForwardFromId(fwdFrom)).toBe(-1000000011111)
  })

  it('returns undefined when no forward header', () => {
    expect(extractForwardFromId(undefined)).toBeUndefined()
  })

  it('returns undefined when forward header has no fromId', () => {
    const fwdFrom: RawMessageFwdHeader = {
      _: 'messageFwdHeader',
      fromName: 'Anonymous User',
      date: Date.now(),
    }
    expect(extractForwardFromId(fwdFrom)).toBeUndefined()
  })
})

describe('determineMessageType', () => {
  it('returns "text" for text-only messages', () => {
    const msg: RawMessage = {
      _: 'message',
      id: 1,
      peerId: { _: 'peerUser', userId: 123 },
      message: 'Hello!',
      date: Date.now(),
    }
    expect(determineMessageType(msg)).toBe('text')
  })

  it('returns "service" for service messages', () => {
    const msg: RawMessage = {
      _: 'messageService',
      id: 1,
      peerId: { _: 'peerChat', chatId: 123 },
      date: Date.now(),
    }
    expect(determineMessageType(msg)).toBe('service')
  })

  it('returns "empty" for empty messages', () => {
    const msg: RawMessage = {
      _: 'messageEmpty',
      id: 1,
      peerId: { _: 'peerUser', userId: 123 },
      date: Date.now(),
    }
    expect(determineMessageType(msg)).toBe('empty')
  })

  it('returns "photo" for photo messages', () => {
    const msg: RawMessage = photoMessage({ _: 'peerUser', userId: 123 }, 1)
    expect(determineMessageType(msg)).toBe('photo')
  })

  it('returns "document" for document messages', () => {
    const msg: RawMessage = pdfDocumentMessage(
      { _: 'peerUser', userId: 123 },
      1,
    )
    expect(determineMessageType(msg)).toBe('document')
  })

  it('returns the kind of file for voice, video and sticker messages', () => {
    const peer = { _: 'peerUser' as const, userId: 123 }
    expect(determineMessageType(voiceMessage(peer, 1))).toBe('voice')
    expect(determineMessageType(videoMessage(peer, 2))).toBe('video')
    expect(determineMessageType(stickerMessage(peer, 3))).toBe('sticker')
  })

  it('returns "text" for media without its photo or document', () => {
    const msg: RawMessage = {
      _: 'message',
      id: 1,
      peerId: { _: 'peerUser', userId: 123 },
      date: Date.now(),
      media: { _: 'messageMediaDocument', ttlSeconds: 10 },
    }
    expect(determineMessageType(msg)).toBe('text')
  })

  it('returns "webpage" for web page messages', () => {
    const msg: RawMessage = webpageMessage({ _: 'peerUser', userId: 123 }, 1)
    expect(determineMessageType(msg)).toBe('webpage')
  })

  it('returns "location" for geo messages', () => {
    const msg: RawMessage = {
      _: 'message',
      id: 1,
      peerId: { _: 'peerUser', userId: 123 },
      date: Date.now(),
      media: {
        _: 'messageMediaGeo',
        geo: { _: 'geoPoint', long: 13.4, lat: 52.5, accessHash: 0 },
      },
    }
    expect(determineMessageType(msg)).toBe('location')
  })
})

describe('parseRawMessage', () => {
  it('parses a basic text message', () => {
    const raw: RawMessage = {
      _: 'message',
      id: 100,
      peerId: { _: 'peerUser', userId: 123 },
      fromId: { _: 'peerUser', userId: 456 },
      message: 'Hello, world!',
      date: 1700000000,
      out: false,
    }

    const result = parseRawMessage(raw, 123)

    expect(result).toEqual({
      chatId: 123,
      messageId: 100,
      fromId: 456,
      text: 'Hello, world!',
      date: 1700000000,
      isOutgoing: false,
      replyToId: undefined,
      forwardFromId: undefined,
      messageType: 'text',
      hasMedia: false,
      isPinned: undefined,
    })
  })

  it('parses a message forwarded from a user', () => {
    const raw: RawMessage = {
      _: 'message',
      id: 200,
      peerId: { _: 'peerChat', chatId: 999 },
      fromId: { _: 'peerUser', userId: 111 },
      message: 'Forwarded text',
      date: 1700000100,
      out: false,
      fwdFrom: {
        _: 'messageFwdHeader',
        fromId: { _: 'peerUser', userId: 222 },
        date: 1700000000,
      },
    }

    const result = parseRawMessage(raw, 999)

    expect(result.forwardFromId).toBe(222)
    expect(result.fromId).toBe(111)
  })

  it('parses a message forwarded from a basic group (peerChat)', () => {
    const raw: RawMessage = {
      _: 'message',
      id: 300,
      peerId: { _: 'peerUser', userId: 123 },
      fromId: { _: 'peerUser', userId: 123 },
      message: 'Forwarded from a group',
      date: 1700000200,
      out: false,
      fwdFrom: {
        _: 'messageFwdHeader',
        fromId: { _: 'peerChat', chatId: 55555 },
        date: 1700000100,
      },
    }

    const result = parseRawMessage(raw, 123)

    expect(result.forwardFromId).toBe(-55555)
  })

  it('parses a message forwarded from a channel', () => {
    const raw: RawMessage = {
      _: 'message',
      id: 400,
      peerId: { _: 'peerChat', chatId: 999 },
      fromId: { _: 'peerUser', userId: 111 },
      message: 'Forwarded from channel',
      date: 1700000300,
      out: false,
      fwdFrom: {
        _: 'messageFwdHeader',
        fromId: { _: 'peerChannel', channelId: 77777 },
        date: 1700000200,
        channelPost: 42,
      },
    }

    const result = parseRawMessage(raw, 999)

    expect(result.forwardFromId).toBe(-1000000077777)
  })

  it('parses a reply message', () => {
    const raw: RawMessage = {
      _: 'message',
      id: 500,
      peerId: { _: 'peerUser', userId: 123 },
      fromId: { _: 'peerUser', userId: 456 },
      message: 'This is a reply',
      date: 1700000400,
      out: true,
      replyTo: {
        _: 'messageReplyHeader',
        replyToMsgId: 400,
      },
    }

    const result = parseRawMessage(raw, 123)

    expect(result.replyToId).toBe(400)
    expect(result.isOutgoing).toBe(true)
  })

  it('parses a message with media', () => {
    const raw: RawMessage = {
      _: 'message',
      id: 600,
      peerId: { _: 'peerChannel', channelId: 888 },
      message: 'Photo caption',
      date: 1700000500,
      out: false,
      media: photoMessage({ _: 'peerChannel', channelId: 888 }, 600).media,
      pinned: true,
    }

    const result = parseRawMessage(raw, 888)

    expect(result.messageType).toBe('photo')
    expect(result.hasMedia).toBe(true)
    expect(result.isPinned).toBe(true)
  })

  it('handles message without fromId (channel posts)', () => {
    const raw: RawMessage = {
      _: 'message',
      id: 700,
      peerId: { _: 'peerChannel', channelId: 999 },
      message: 'Channel announcement',
      date: 1700000600,
      out: false,
    }

    const result = parseRawMessage(raw, 999)

    // The channel is the sender, as mtcute gives it to live messages
    expect(result.fromId).toBe(-1000000000999)
  })
})

describe('parseRawMessages', () => {
  it('parses multiple messages', () => {
    const messages: RawMessage[] = [
      {
        _: 'message',
        id: 1,
        peerId: { _: 'peerChat', chatId: 100 },
        fromId: { _: 'peerUser', userId: 1 },
        message: 'First',
        date: 1700000000,
      },
      {
        _: 'message',
        id: 2,
        peerId: { _: 'peerChat', chatId: 100 },
        fromId: { _: 'peerUser', userId: 2 },
        message: 'Second',
        date: 1700000001,
      },
    ]

    const results = parseRawMessages(messages, 100)

    expect(results).toHaveLength(2)
    expect(results[0]!.messageId).toBe(1)
    expect(results[1]!.messageId).toBe(2)
  })

  it('filters out empty messages', () => {
    const messages: RawMessage[] = [
      {
        _: 'message',
        id: 1,
        peerId: { _: 'peerChat', chatId: 100 },
        message: 'Valid',
        date: 1700000000,
      },
      {
        _: 'messageEmpty',
        id: 2,
        peerId: { _: 'peerChat', chatId: 100 },
        date: 1700000001,
      },
      {
        _: 'message',
        id: 3,
        peerId: { _: 'peerChat', chatId: 100 },
        message: 'Also valid',
        date: 1700000002,
      },
    ]

    const results = parseRawMessages(messages, 100)

    expect(results).toHaveLength(2)
    expect(results[0]!.messageId).toBe(1)
    expect(results[1]!.messageId).toBe(3)
  })

  it('handles forwarded messages from all peer types in batch', () => {
    const messages: RawMessage[] = [
      {
        _: 'message',
        id: 1,
        peerId: { _: 'peerUser', userId: 123 },
        message: 'From user',
        date: 1700000000,
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerUser', userId: 100 },
          date: 1700000000,
        },
      },
      {
        _: 'message',
        id: 2,
        peerId: { _: 'peerUser', userId: 123 },
        message: 'From basic group',
        date: 1700000001,
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerChat', chatId: 200 },
          date: 1700000000,
        },
      },
      {
        _: 'message',
        id: 3,
        peerId: { _: 'peerUser', userId: 123 },
        message: 'From channel',
        date: 1700000002,
        fwdFrom: {
          _: 'messageFwdHeader',
          fromId: { _: 'peerChannel', channelId: 300 },
          date: 1700000000,
        },
      },
    ]

    const results = parseRawMessages(messages, 123)

    expect(results).toHaveLength(3)
    expect(results[0]!.forwardFromId).toBe(100) // from user
    expect(results[1]!.forwardFromId).toBe(-200) // from basic group (peerChat)
    expect(results[2]!.forwardFromId).toBe(-1000000000300) // from channel
  })
})

describe('Issue #25: peerChat forward handling', () => {
  it('correctly handles forwarded messages from basic groups', () => {
    // This is the specific case from Issue #25
    // Forwarded messages from basic groups should have forward_from_id set
    const raw: RawMessage = {
      _: 'message',
      id: 1,
      peerId: { _: 'peerUser', userId: 111 },
      fromId: { _: 'peerUser', userId: 111 },
      message: 'Message originally from a basic group chat',
      date: Date.now(),
      fwdFrom: {
        _: 'messageFwdHeader',
        fromId: { _: 'peerChat', chatId: 12345 }, // This is the key - peerChat not peerUser/peerChannel
        date: Date.now() - 1000,
      },
    }

    const result = parseRawMessage(raw, 111)

    // Previously this would be null because peerChat wasn't handled
    expect(result.forwardFromId).toBe(-12345)
    expect(result.forwardFromId).not.toBeNull()
    expect(result.forwardFromId).not.toBeUndefined()
  })
})
