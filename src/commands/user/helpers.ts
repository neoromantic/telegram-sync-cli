import type { tl } from "@mtcute/bun";

import type { CachedUser, UsersCache } from "../../db/users-cache";

export interface UserInfo {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  phone: string | null;
  isBot: boolean;
  isPremium: boolean;
  isContact: boolean;
}

export type UserIdentifierKind = "username" | "phone" | "id";

export interface ParsedIdentifier {
  kind: UserIdentifierKind;
  value: string;
  raw: string;
}

export function isRawUser(user: tl.TypeUser): user is tl.RawUser {
  return user._ === "user";
}

export function apiUserToUserInfo(user: tl.RawUser) {
  return {
    id: user.id,
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? null,
    username: user.username ?? null,
    phone: user.phone ?? null,
    isBot: Boolean(user.bot),
    isPremium: Boolean(user.premium),
    isContact: Boolean(user.contact),
  };
}

export function cachedUserToUserInfo(cached: CachedUser) {
  return {
    id: Number(cached.user_id),
    firstName: cached.first_name ?? "",
    lastName: cached.last_name ?? null,
    username: cached.username ?? null,
    phone: cached.phone ?? null,
    isBot: cached.is_bot === 1,
    isPremium: cached.is_premium === 1,
    isContact: cached.is_contact === 1,
  };
}

export function parseUserIdentifier(identifier: string) {
  if (
    identifier.startsWith("@") ||
    (Number.isNaN(Number(identifier)) && !identifier.startsWith("+"))
  ) {
    const result: ParsedIdentifier = {
      kind: "username",
      value: identifier.startsWith("@") ? identifier.slice(1) : identifier,
      raw: identifier,
    };
    return result;
  }

  if (identifier.startsWith("+") || /^\d{10,}$/.test(identifier)) {
    const result: ParsedIdentifier = {
      kind: "phone",
      value: identifier.replace(/[\s+\-()]/g, ""),
      raw: identifier,
    };
    return result;
  }

  const result: ParsedIdentifier = { kind: "id", value: identifier, raw: identifier };
  return result;
}

export function findCachedUser(usersCache: UsersCache, parsed: ParsedIdentifier) {
  if (parsed.kind === "username") {
    return usersCache.getByUsername(parsed.raw);
  }

  if (parsed.kind === "phone") {
    return usersCache.getByPhone(parsed.value);
  }

  return usersCache.getById(parsed.value);
}
