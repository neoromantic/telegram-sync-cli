export function isUsernameIdentifier(identifier: string): boolean {
  return identifier.startsWith('@') || Number.isNaN(Number(identifier))
}

export function normalizeUsername(identifier: string): string {
  return identifier.replace(/^@/, '')
}
