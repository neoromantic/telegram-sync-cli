import { describe, expect, it } from 'bun:test'

import { buildSnippet, snippetTerms } from '../utils/search-snippet'

const words = (query: string, phrase = false) =>
  snippetTerms(query, { phrase }).map(
    (term) => `${term.text}${term.prefix ? '*' : ''}`,
  )

describe('snippetTerms', () => {
  it('takes every word of a plain query, folded like unicode61', () => {
    expect(words('Hello World')).toEqual(['hello', 'world'])
    expect(words("don't Café")).toEqual(['don', 't', 'cafe'])
    expect(words('Квартира')).toEqual(['квартира'])
  })

  it('reads phrases, prefixes and operators', () => {
    expect(words('"exact phrase" OR hel*')).toEqual(['exact', 'phrase', 'hel*'])
    expect(words('квартир* AND "big room"*')).toEqual([
      'квартир*',
      'big',
      'room*',
    ])
    expect(words('^start + next')).toEqual(['start', 'next'])
    expect(words('NEAR(one two, 5) three')).toEqual(['one', 'two', 'three'])
    expect(words('(alpha OR beta) gamma')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('leaves out NOT terms and column filters other than text', () => {
    expect(words('hello NOT world')).toEqual(['hello'])
    expect(words('hello NOT (a OR b) c')).toEqual(['hello', 'c'])
    expect(words('sender:alice chat:team deploy')).toEqual(['deploy'])
    expect(words('{sender chat}:alice text:deploy')).toEqual(['deploy'])
    expect(words('-sender:alice')).toEqual(['alice'])
    expect(words('-text:alice report')).toEqual(['report'])
    expect(words('chat:(team OR club) report')).toEqual(['report'])
  })

  it('takes the words of the whole query with phrase', () => {
    expect(words('function(arg) call', true)).toEqual([
      'function',
      'arg',
      'call',
    ])
  })
})

describe('buildSnippet', () => {
  const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ')

  it('highlights every matching word in a short text', () => {
    expect(
      buildSnippet('Hello there, hello again', snippetTerms('hello')),
    ).toBe('**Hello** there, **hello** again')
  })

  it('cuts about ten words on each side of the first match', () => {
    expect(buildSnippet(long, snippetTerms('w15'))).toBe(
      '…w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 **w15** w16 w17 w18 w19 w20 w21 w22 w23 w24 w25…',
    )
    expect(buildSnippet(long, snippetTerms('w2'))).toBe(
      'w0 w1 **w2** w3 w4 w5 w6 w7 w8 w9 w10 w11 w12…',
    )
  })

  it('matches prefixes, Cyrillic and Latin diacritics', () => {
    expect(
      buildSnippet(
        'Сдаю КВАРТИРУ, квартира свободна',
        snippetTerms('квартир*'),
      ),
    ).toBe('Сдаю **КВАРТИРУ**, **квартира** свободна')
    expect(buildSnippet('Meet at the café', snippetTerms('cafe'))).toBe(
      'Meet at the **café**',
    )
    expect(buildSnippet('йогурт и иогурт', snippetTerms('йогурт'))).toBe(
      '**йогурт** и иогурт',
    )
  })

  it('starts at the beginning of the text without a match in it', () => {
    expect(buildSnippet(long, snippetTerms('sender:alice'))).toBe(
      'w0 w1 w2 w3 w4 w5 w6 w7 w8 w9 w10 w11 w12 w13 w14 w15 w16 w17 w18 w19 w20…',
    )
    expect(buildSnippet('short note', snippetTerms('sender:alice'))).toBe(
      'short note',
    )
  })

  it('reads whitespace runs as one space and handles empty text', () => {
    expect(buildSnippet('line one\n\nline  two', snippetTerms('two'))).toBe(
      'line one line **two**',
    )
    expect(buildSnippet(null, snippetTerms('x'))).toBe('')
    expect(buildSnippet('👍', snippetTerms('x'))).toBe('👍')
  })
})
