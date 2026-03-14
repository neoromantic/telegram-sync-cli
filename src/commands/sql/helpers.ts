const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|DETACH|VACUUM|REINDEX)\b/

export function isReadOnlyQuery(query: string): boolean {
  const normalized = query.trim().replace(/\s+/g, ' ').toUpperCase()

  const startsWithAllowed =
    normalized.startsWith('SELECT ') ||
    normalized.startsWith('WITH ') ||
    normalized.startsWith('PRAGMA ')

  if (!startsWithAllowed) {
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
  if (/\bLIMIT\b/i.test(withoutSemicolon)) return withoutSemicolon

  return `${withoutSemicolon} LIMIT ${limit}`
}
