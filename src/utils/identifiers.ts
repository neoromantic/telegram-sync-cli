export function isUsernameIdentifier(identifier: string) {
  return identifier.startsWith("@") || Number.isNaN(Number(identifier));
}

export function normalizeUsername(identifier: string) {
  return identifier.replace(/^@/, "");
}
