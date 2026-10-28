/**
 * Search snippets: a fragment of a message's text around the first word a
 * query matched, matched words in `**`. FTS5's snippet() needs the text in
 * the index, which the contentless index doesn't keep, so tg builds them.
 */
import { hasFts5Syntax } from '../db/messages-search'

/** A word to highlight; a prefix term (`hel*`) matches words that start with it */
export interface SnippetTerm {
  text: string
  prefix: boolean
}

/** Words on each side of the first match */
const CONTEXT_WORDS = 10

/** A token as FTS5's unicode61 sees one: letters, digits and marks */
const TOKEN = /[\p{L}\p{N}\p{Co}\p{M}]+/gu

/** The longest fragment, in UTF-16 code units, for text with long words or none */
const MAX_SNIPPET_LENGTH = 300

/**
 * A token compared the way unicode61 (remove_diacritics=1) compares it:
 * case-insensitive, and a Latin letter with one diacritic is the bare
 * letter (`café` is `cafe`). A letter with two keeps them (`ộ` is not `o`),
 * and other scripts keep theirs (`й` stays `й`).
 */
function fold(token: string): string {
  return token
    .toLowerCase()
    .normalize('NFD')
    .replace(/(\p{Script=Latin})(\p{M}+)/gu, (letter, base, marks) =>
      [...marks].length === 1 ? base : letter,
    )
    .normalize('NFC')
}

/** An offset moved off the second half of a surrogate pair, so no emoji is cut */
function keepPair(text: string, at: number): number {
  const code = text.charCodeAt(at)
  return at > 0 && code >= 0xdc00 && code <= 0xdfff ? at - 1 : at
}

function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? []
}

/** The terms of one phrase: its words, the last one a prefix when `*` follows */
function phraseTerms(text: string, prefix: boolean): SnippetTerm[] {
  const words = tokenize(text).map(fold)
  return words.map((word, i) => ({
    text: word,
    prefix: prefix && i === words.length - 1,
  }))
}

/** The query split the way FTS5 reads it: strings, barewords and punctuation */
function lexQuery(query: string): Array<{ kind: string; text: string }> {
  const tokens: Array<{ kind: string; text: string }> = []
  let i = 0
  while (i < query.length) {
    const ch = query[i]!
    if (/\s/.test(ch)) {
      i++
    } else if (ch === '"') {
      let text = ''
      i++
      while (i < query.length) {
        if (query[i] === '"') {
          if (query[i + 1] !== '"') break
          i++
        }
        text += query[i]
        i++
      }
      i++
      tokens.push({ kind: 'string', text })
    } else if ('(){}:*^+,-'.includes(ch)) {
      tokens.push({ kind: ch, text: ch })
      i++
    } else {
      let text = ''
      while (i < query.length && !/[\s"(){}:*^+,-]/.test(query[i]!)) {
        text += query[i]
        i++
      }
      tokens.push({ kind: 'word', text })
    }
  }
  return tokens
}

const OPERATORS = new Set(['AND', 'OR', 'NOT', 'NEAR'])

/**
 * The query's free-text terms: the words FTS5 matches in the message text.
 * Terms under a column filter without `text` (`sender:alice`, `chat:team`)
 * and under `NOT` are left out, since they don't occur in the text.
 */
export function snippetTerms(
  query: string,
  options: { phrase?: boolean } = {},
): SnippetTerm[] {
  if (options.phrase || !hasFts5Syntax(query)) return phraseTerms(query, false)

  const tokens = lexQuery(query)
  let pos = 0
  const peek = () => tokens[pos]
  const isOperator = (token = peek()) =>
    token?.kind === 'word' && OPERATORS.has(token.text)

  /** A phrase, `^` and `+` joined phrases included, with its prefix stars */
  function phrase(): SnippetTerm[] {
    const terms: SnippetTerm[] = []
    while (pos < tokens.length) {
      if (peek()!.kind === '^') pos++
      const token = peek()
      if (!token || (token.kind !== 'word' && token.kind !== 'string')) break
      if (isOperator(token)) break
      pos++
      const prefix = peek()?.kind === '*'
      if (prefix) pos++
      terms.push(...phraseTerms(token.text, prefix))
      if (peek()?.kind !== '+') break
      pos++
    }
    return terms
  }

  /** Whether a column filter lets its operand match the text column */
  function columnFilter(): boolean | undefined {
    const start = pos
    const negated = peek()?.kind === '-'
    if (negated) pos++
    const columns: string[] = []
    if (peek()?.kind === '{') {
      pos++
      while (peek() && peek()!.kind !== '}') columns.push(tokens[pos++]!.text)
      pos++
    } else if (peek()?.kind === 'word' && tokens[pos + 1]?.kind === ':') {
      columns.push(tokens[pos++]!.text)
    }
    if (columns.length === 0 || peek()?.kind !== ':') {
      pos = start
      return undefined
    }
    pos++
    const text = columns.some((column) => column.toLowerCase() === 'text')
    return negated ? !text : text
  }

  /** One operand: a phrase, a NEAR group or a parenthesized expression */
  function operand(): SnippetTerm[] {
    const inText = columnFilter() ?? true
    let terms: SnippetTerm[]
    if (peek()?.kind === '(') {
      pos++
      terms = expression()
      pos++
    } else if (peek()?.text === 'NEAR' && tokens[pos + 1]?.kind === '(') {
      pos += 2
      terms = []
      while (peek() && peek()!.kind !== ')') {
        if (peek()!.kind === ',') {
          pos += 2
          continue
        }
        const found = phrase()
        if (found.length === 0) pos++
        terms.push(...found)
      }
      pos++
    } else {
      terms = phrase()
      if (terms.length === 0 && pos < tokens.length) pos++
    }
    return inText ? terms : []
  }

  function expression(): SnippetTerm[] {
    const terms: SnippetTerm[] = []
    while (pos < tokens.length && peek()!.kind !== ')') {
      const token = peek()!
      if (
        token.kind === 'word' &&
        (token.text === 'AND' || token.text === 'OR')
      ) {
        pos++
      } else if (token.kind === 'word' && token.text === 'NOT') {
        pos++
        operand()
      } else {
        terms.push(...operand())
      }
    }
    return terms
  }

  return expression()
}

function matches(word: string, terms: SnippetTerm[]): boolean {
  const folded = fold(word)
  return terms.some((term) =>
    term.prefix ? folded.startsWith(term.text) : folded === term.text,
  )
}

/**
 * A fragment of the text around the first word that matches a term, about
 * ten words on each side and at most MAX_SNIPPET_LENGTH long, `…` where it
 * is cut, every matching word in `**`. Without such a word (a message found
 * by its sender or chat) it is the start of the text. Whitespace runs read
 * as one space.
 */
export function buildSnippet(
  text: string | null,
  terms: SnippetTerm[],
): string {
  if (!text) return ''
  const words = [...text.matchAll(TOKEN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    hit: matches(match[0], terms),
  }))
  const first = Math.max(
    0,
    words.findIndex((word) => word.hit),
  )
  const hit = words[first]?.hit ?? false
  const from = first - CONTEXT_WORDS
  const to = first + CONTEXT_WORDS + (hit ? 0 : CONTEXT_WORDS)
  let start = from <= 0 ? 0 : words[from]!.start
  let end = to >= words.length - 1 ? text.length : words[to]!.end

  // Long words, or emoji with no words at all, can make ten words a lot of
  // text: keep the match in view and cut the rest
  if (end - start > MAX_SNIPPET_LENGTH) {
    const anchor = hit ? words[first]!.start : start
    start = keepPair(text, Math.max(start, anchor - MAX_SNIPPET_LENGTH / 2))
    end = keepPair(text, Math.min(end, start + MAX_SNIPPET_LENGTH))
  }

  let out = ''
  let at = start
  for (const word of words) {
    if (word.start < start || word.end > end || !word.hit) continue
    out += `${text.slice(at, word.start)}**${text.slice(word.start, word.end)}**`
    at = word.end
  }
  out += text.slice(at, end)

  const fragment = out.replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${fragment}${end < text.length ? '…' : ''}`
}
