import type { Database } from "bun:sqlite";
import { type TelegramClient, tl } from "@mtcute/bun";

import { getErrorMessage } from "../../daemon/daemon-utils";
import { type ChatSyncStateService, createChatSyncStateService } from "../../db/chat-sync-state";
import type { CachedChat, ChatsCache } from "../../db/chats-cache";
import { createMessagesCache, type MessagesCache } from "../../db/messages-cache";
import type { CachedUser, UsersCache } from "../../db/users-cache";
import { isUsernameIdentifier, normalizeUsername } from "../../utils/identifiers";
import { toLong } from "../../utils/long";
import { verbose } from "../../utils/output";
import { apiUserToCacheInput } from "../../utils/telegram-mappers";
import { toInputPeerFromPeerId, toMarkedPeerId } from "../../utils/telegram-peer-ids";
import { resolveUsername } from "../../utils/telegram-resolve";
import { rawPeerToCacheInput } from "../chats/helpers";

export type ResolvedPeer = { inputPeer: tl.TypeInputPeer; name: string };

/** The identifier can't name a peer: bad input, not a Telegram failure */
export class InvalidPeerError extends Error {
  readonly identifier: string;

  constructor(identifier: string) {
    super(`Invalid peer identifier: ${identifier}`);
    this.name = "InvalidPeerError";
    this.identifier = identifier;
  }
}

/**
 * A bare ID that 0.2.0 or older printed for a chat, which the cache knows as
 * both basic group N and channel N: bad input, the caller passes the
 * marked ID it means.
 */
export class AmbiguousPeerError extends Error {
  readonly identifier: string;
  /** The marked IDs of the cached chats the number can name */
  readonly candidates: number[];

  constructor(identifier: string, candidates: number[]) {
    super(`Ambiguous chat ID ${identifier}: pass one of the marked IDs ${candidates.join(", ")}`);
    this.name = "AmbiguousPeerError";
    this.identifier = identifier;
    this.candidates = candidates;
  }
}

type TelegramClientLike = Pick<TelegramClient, "call">;

/**
 * The cache tables that know a DM without a users_cache row: sync state (a
 * positive chat ID in chat_sync_state is always a user) and messages cached
 * under the user ID, which only a private chat has
 */
export type DmLookup = {
  chatSyncState: Pick<ChatSyncStateService, "get">;
  messagesCache: Pick<MessagesCache, "getOldestMessageId">;
};

export function createDmLookup(db: Database) {
  const result: DmLookup = {
    chatSyncState: createChatSyncStateService(db),
    messagesCache: createMessagesCache(db),
  };
  return result;
}

/**
 * Whether the cache knows user N: a users_cache row, sync state for the DM
 * or messages cached under N. Every command that reads a chat ID asks this
 * before it takes a positive ID as a group or channel ID as 0.2.0 printed
 * it, so `tg send`, `tg messages` and `tg chats` name the same chat.
 */
export function isKnownUserId(
  usersCache: Pick<UsersCache, "getById">,
  dms: DmLookup | undefined,
  id: number,
) {
  return (
    usersCache.getById(String(id)) !== null ||
    dms?.chatSyncState.get(id) != null ||
    dms?.messagesCache.getOldestMessageId(id) != null
  );
}

type CacheDeps = {
  usersCache: UsersCache;
  chatsCache: ChatsCache;
  dms?: DmLookup;
};

type CachedUserRef = Pick<CachedUser, "user_id" | "access_hash" | "display_name">;

function buildUserPeerFromCache(user: CachedUserRef, fallbackName: string) {
  const result: ResolvedPeer = {
    inputPeer: {
      _: "inputPeerUser",
      userId: Number(user.user_id),
      accessHash: toLong(user.access_hash),
    },
    name: user.display_name || fallbackName,
  };
  return result;
}

function buildUserPeerFromApi(user: tl.RawUser, fallbackName: string) {
  const result: ResolvedPeer = {
    inputPeer: {
      _: "inputPeerUser",
      userId: user.id,
      accessHash: toLong(user.accessHash),
    },
    name: [user.firstName, user.lastName].filter(Boolean).join(" ") || fallbackName,
  };
  return result;
}

function cacheResolvedUser(usersCache: UsersCache, user: tl.RawUser) {
  if (user.min) return;
  try {
    usersCache.upsert(apiUserToCacheInput(user));
  } catch (err) {
    verbose(`Could not cache user ${user.id}: ${getErrorMessage(err)}`);
  }
}

type ResolvedChannel = tl.RawChannel | tl.RawChannelForbidden;

function buildChannelPeerFromApi(chat: ResolvedChannel, fallbackName: string) {
  const result: ResolvedPeer = {
    inputPeer: {
      _: "inputPeerChannel",
      channelId: chat.id,
      accessHash: toLong(chat.accessHash),
    },
    name: chat.title || fallbackName,
  };
  return result;
}

function buildGroupPeer(chatId: number, fallbackName: string) {
  const result: ResolvedPeer = {
    inputPeer: {
      _: "inputPeerChat",
      chatId,
    },
    name: fallbackName,
  };
  return result;
}

function normalizePhone(identifier: string) {
  if (!identifier.startsWith("+") && !/^\d{10,}$/.test(identifier)) {
    return null;
  }
  const phone = identifier.replace(/[\s\-+()]/g, "");
  return /^\d+$/.test(phone) ? phone : null;
}

async function resolveByUsername(
  client: TelegramClientLike,
  username: string,
  { usersCache, chatsCache }: CacheDeps,
  fresh: boolean,
) {
  const cachedUser = fresh ? null : usersCache.getByUsername(username);
  if (cachedUser?.access_hash) {
    verbose(`Found user @${username} in cache`);
    return buildUserPeerFromCache(cachedUser, `@${username}`);
  }

  const cachedChat = fresh ? null : chatsCache.getByUsername(username);
  if (
    cachedChat?.access_hash &&
    (cachedChat.type === "channel" || cachedChat.type === "supergroup")
  ) {
    const peer = peerFromCachedChat(cachedChat, `@${username}`);
    if (peer?.inputPeer._ === "inputPeerChannel") {
      verbose(`Found chat @${username} in cache`);
      return peer;
    }
  }

  verbose(`Resolving @${username} via API...`);
  const resolved = await resolveUsername(client, username);
  const resolvedUser = resolved.users?.find((user): user is tl.RawUser => user._ === "user");
  if (resolvedUser) {
    cacheResolvedUser(usersCache, resolvedUser);
    return buildUserPeerFromApi(resolvedUser, `@${username}`);
  }

  const resolvedChat = resolved.chats?.[0];
  if (resolvedChat) {
    const cacheInput = rawPeerToCacheInput(resolvedChat);
    if (cacheInput) {
      const known = chatsCache.getById(cacheInput.chat_id);
      chatsCache.upsert({
        ...cacheInput,
        member_count: cacheInput.member_count ?? known?.member_count ?? null,
        last_message_id: known?.last_message_id ?? null,
        last_message_at: known?.last_message_at ?? null,
      });
    }
    if (resolvedChat._ === "channel" || resolvedChat._ === "channelForbidden")
      return buildChannelPeerFromApi(resolvedChat, `@${username}`);
    if (resolvedChat._ === "chat" || resolvedChat._ === "chatForbidden")
      return buildGroupPeer(resolvedChat.id, `@${username}`);
  }

  throw new Error(`Could not resolve @${username}`);
}

async function resolveByPhone(
  client: TelegramClientLike,
  identifier: string,
  phone: string,
  { usersCache }: CacheDeps,
) {
  const cachedUser = usersCache.getByPhone(phone);
  if (cachedUser?.access_hash) {
    verbose(`Found user with phone ${identifier} in cache`);
    return buildUserPeerFromCache(cachedUser, identifier);
  }

  verbose(`Resolving phone ${identifier} via API...`);
  let resolvedUser: tl.RawUser | null;
  try {
    const request: tl.contacts.RawResolvePhoneRequest = {
      _: "contacts.resolvePhone",
      phone,
    };
    const resolved = await client.call(request);
    resolvedUser = resolved.users?.find((user): user is tl.RawUser => user._ === "user") ?? null;
  } catch (err) {
    if (!tl.RpcError.is(err) || err.code === tl.RpcError.FLOOD) throw err;
    resolvedUser = null;
  }

  if (resolvedUser) {
    cacheResolvedUser(usersCache, resolvedUser);
    return buildUserPeerFromApi(resolvedUser, identifier);
  }

  throw new Error(`Could not resolve phone number ${identifier}`);
}

function peerFromCachedChat(chat: CachedChat, fallbackName?: string) {
  const id = Number(chat.chat_id);
  const inputPeer = toInputPeerFromPeerId(id, chat.access_hash);
  if (!inputPeer) {
    const result: ResolvedPeer | null = null;
    return result;
  }
  const result: ResolvedPeer | null = {
    inputPeer,
    name: chat.title || fallbackName || `Chat ${id}`,
  };
  return result;
}

function resolveLegacyChatId(identifier: string, { chatsCache }: CacheDeps) {
  const matches = chatsCache.getByLegacyId(Number(identifier));
  if (matches.length > 1) {
    throw new AmbiguousPeerError(
      identifier,
      matches.map((chat) => Number(chat.chat_id)),
    );
  }
  const [chat] = matches;
  if (!chat) {
    const result: ResolvedPeer | null = null;
    return result;
  }
  verbose(`Found chat ${chat.chat_id} in cache for the old ID ${identifier}`);
  return peerFromCachedChat(chat);
}

function peerFromBareChatRow(chat: CachedChat | null) {
  if (!chat || chat.type === "private") {
    const result: ResolvedPeer | null = null;
    return result;
  }
  const marked = toMarkedPeerId(Number(chat.chat_id), chat.type);
  verbose(`Found chat ${marked} in cache under the old ID ${chat.chat_id}`);
  return peerFromCachedChat({ ...chat, chat_id: String(marked) });
}

function resolveCachedId(identifier: string, deps: CacheDeps) {
  const { usersCache, chatsCache, dms } = deps;
  const cachedUser = usersCache.getById(identifier);
  if (cachedUser?.access_hash) {
    verbose(`Found user ID ${identifier} in cache`);
    const result: ResolvedPeer | null = buildUserPeerFromCache(cachedUser, `User ${identifier}`);
    return result;
  }

  const cachedChat = chatsCache.getById(identifier);
  if (cachedChat?.type === "private") {
    verbose(`Found chat ID ${identifier} in cache`);
    return peerFromCachedChat(cachedChat, `User ${identifier}`);
  }

  const id = Number(identifier);
  if (Number.isSafeInteger(id) && isKnownUserId(usersCache, dms, id)) {
    verbose(`Found private chat ${identifier} in cache, without an access hash`);
    const result: ResolvedPeer | null = buildUserPeerFromCache(
      cachedUser ?? {
        user_id: identifier,
        access_hash: null,
        display_name: null,
      },
      `User ${identifier}`,
    );
    return result;
  }

  const result: ResolvedPeer | null =
    resolveLegacyChatId(identifier, deps) ?? peerFromBareChatRow(cachedChat);
  return result;
}

function resolveUncachedId(identifier: string) {
  const userId = /^\d+$/.test(identifier) ? Number(identifier) : 0;
  const inputPeer = toInputPeerFromPeerId(userId, null);
  if (!inputPeer) throw new InvalidPeerError(identifier);
  const result: ResolvedPeer = { inputPeer, name: `User ${userId}` };
  return result;
}

function resolveByMarkedId(identifier: string, { chatsCache }: CacheDeps) {
  const marked = Number(identifier);
  if (!Number.isSafeInteger(marked) || marked >= 0) {
    throw new InvalidPeerError(identifier);
  }

  const cachedChat = chatsCache.getById(String(marked));
  const cachedPeer = cachedChat ? peerFromCachedChat(cachedChat) : null;
  if (cachedPeer) {
    verbose(`Found chat ID ${identifier} in cache`);
    return cachedPeer;
  }

  const inputPeer = toInputPeerFromPeerId(marked, null);
  if (!inputPeer) throw new InvalidPeerError(identifier);
  const result: ResolvedPeer = { inputPeer, name: `Chat ${identifier}` };
  return result;
}

const SELF_IDENTIFIERS = new Set(["me", "self"]);

export interface ResolvePeerOptions {
  /**
   * Resolve an @username through Telegram, not the cache: a username can
   * move to another chat, and its old owner keeps it in the cache. Writes
   * pass it, so they never act on the previous owner.
   */
  freshUsername?: boolean;
}

export async function resolvePeer(
  client: TelegramClientLike,
  identifier: string,
  usersCache: UsersCache,
  chatsCache: ChatsCache,
  dms?: DmLookup,
  { freshUsername = false }: ResolvePeerOptions = {},
) {
  const normalized = identifier.trim();
  const deps = { usersCache, chatsCache, dms };

  if (SELF_IDENTIFIERS.has(normalized.toLowerCase())) {
    const self: ResolvedPeer = { inputPeer: { _: "inputPeerSelf" }, name: "Saved Messages" };
    return self;
  }

  if (normalized.startsWith("+")) {
    const phone = normalizePhone(normalized);
    if (!phone) throw new InvalidPeerError(normalized);
    return resolveByPhone(client, normalized, phone, deps);
  }

  if (isUsernameIdentifier(normalized)) {
    const username = normalizeUsername(normalized);
    return resolveByUsername(client, username, deps, freshUsername);
  }

  if (/^-\d+$/.test(normalized)) {
    return resolveByMarkedId(normalized, deps);
  }

  const cached = /^\d+$/.test(normalized) ? resolveCachedId(normalized, deps) : null;
  if (cached) return cached;

  const phone = normalizePhone(normalized);
  if (phone) {
    return resolveByPhone(client, normalized, phone, deps);
  }

  return resolveUncachedId(normalized);
}
