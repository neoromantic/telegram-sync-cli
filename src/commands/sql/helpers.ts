const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|DETACH|VACUUM|REINDEX)\b/

/** The pragmas whose argument names what to read, not a value to set */
const READ_PRAGMAS_WITH_ARGUMENT = new Set([
  'TABLE_INFO',
  'TABLE_XINFO',
  'TABLE_LIST',
  'INDEX_LIST',
  'INDEX_INFO',
  'INDEX_XINFO',
  'FOREIGN_KEY_LIST',
  'FOREIGN_KEY_CHECK',
  'INTEGRITY_CHECK',
  'QUICK_CHECK',
])

/**
 * Whether the query holds more than one statement. The cache runs only the
 * first, so the rest would be dropped without a word. Semicolons inside
 * strings, quoted names and comments don't count, nor one at the end.
 */
export function hasSeveralStatements(query: string): boolean {
  let i = 0
  let ended = false
  while (i < query.length) {
    const ch = query[i]!
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch
      i = query.indexOf(close, i + 1)
      if (i === -1) return ended
      i++
    } else if (query.startsWith('--', i)) {
      const end = query.indexOf('\n', i)
      i = end === -1 ? query.length : end + 1
    } else if (query.startsWith('/*', i)) {
      const end = query.indexOf('*/', i + 2)
      i = end === -1 ? query.length : end + 2
    } else if (ch === ';') {
      ended = true
      i++
    } else {
      if (ended && !/\s/.test(ch)) return true
      i++
    }
  }
  return false
}

export function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trim().replace(/\s+/g, ' ').toUpperCase()

  const startsWithAllowed =
    normalized.startsWith('SELECT ') ||
    normalized.startsWith('WITH ') ||
    normalized.startsWith('PRAGMA ')

  if (!startsWithAllowed) {
    return false
  }

  // Setting a pragma writes or changes the file, in either form
  // (PRAGMA user_version = 0, PRAGMA writable_schema(1)); reading one
  // (PRAGMA user_version) or a table's pragma (PRAGMA table_info(t)) is fine
  if (/^PRAGMA [\w.]+ ?=/.test(normalized)) {
    return false
  }
  const call = normalized.match(/^PRAGMA (?:\w+\.)?(\w+) ?\(/)
  if (call && !READ_PRAGMAS_WITH_ARGUMENT.has(call[1]!)) {
    return false
  }

  return !WRITE_KEYWORDS.test(normalized)
}

export function applyQueryLimit(query: string, limit: number): string {
  const trimmed = query.trim()
  const withoutSemicolon = trimmed.endsWith(';')
    ? trimmed.slice(0, -1).trimEnd()
    : trimmed

  if (limit <= 0) return withoutSemicolon
  // A pragma takes no LIMIT clause, and returns few rows
  if (/^PRAGMA\b/i.test(withoutSemicolon)) return withoutSemicolon
  if (/\bLIMIT\b/i.test(withoutSemicolon)) return withoutSemicolon

  return `${withoutSemicolon} LIMIT ${limit}`
}
