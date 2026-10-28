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

  // Setting a pragma (PRAGMA user_version = 0) writes or changes the file;
  // reading one (PRAGMA user_version, PRAGMA table_info(t)) is fine
  if (/^PRAGMA [\w.]+ ?=/.test(normalized)) {
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
