import { defineCommand } from "citty";

import type { CachedChat } from "../../db/chats-cache";
import { getClientForAccount } from "../../services/telegram";
import { openAccountCache } from "../../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../../utils/account-selector";
import { success } from "../../utils/output";
import { wrapClientCallWithRateLimits } from "../../utils/telegram-rate-limits";
import { allowedChatIds } from "../access";
import { fetchChatsFromApi } from "../chats/list";
import { CHAT_ARG_DESCRIPTION, openHistory, parseIntegerArg, reportHistoryError } from "./helpers";
import { resolveHistoryChat } from "./history";
import { fetchUnreadState, readUnread, type UnreadTarget } from "./read-state";

const CONTEXT = "cli:messages.unread";

function chatInfo(chatId: number, row: CachedChat | null) {
  return {
    id: chatId,
    title: row?.title ?? null,
    username: row?.username ?? null,
    type: row?.type ?? null,
  };
}

function cachedState(row: CachedChat | null) {
  if (row?.unread_count == null || row.read_inbox_max_id == null) return null;
  return {
    unreadCount: row.unread_count,
    readInboxMaxId: row.read_inbox_max_id,
  };
}

export const unreadMessagesCommand = defineCommand({
  meta: {
    name: "unread",
    description:
      "Unread messages per chat: the oldest unread ones the cache holds, newest first, with how many are unread and how many the cache lacks (--fresh fetches them)",
  },
  args: {
    chat: {
      type: "string",
      description: `Only this chat. ${CHAT_ARG_DESCRIPTION}`,
    },
    limit: {
      type: "string",
      description: "Messages per chat, 1-100",
      default: "20",
    },
    fresh: {
      type: "boolean",
      description: "Ask Telegram for the unread counts and the unread messages the cache lacks",
      default: false,
    },
    account: {
      type: "string",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
  },
  async run({ args }) {
    const limit = parseIntegerArg(args.limit, "limit", {
      min: 1,
      max: 100,
      default: 20,
    });
    const fresh = args.fresh ?? false;
    const { account } = openAccountCache(args.account);

    try {
      const deps = openHistory(account.id, CONTEXT);
      const { cacheDb, chatsCache, client } = deps;
      let targets: UnreadTarget[];

      if (args.chat) {
        const chat = await resolveHistoryChat(client, args.chat, deps);
        const row = chatsCache.getById(String(chat.chatId));
        const state =
          (!fresh && cachedState(row)) || (await fetchUnreadState(client, cacheDb, chat));
        targets = [
          {
            chat: chatInfo(chat.chatId, row),
            state,
            resolve: async () => chat,
          },
        ];
      } else {
        if (fresh || !chatsCache.hasUnreadState()) {
          const dialogsClient = wrapClientCallWithRateLimits(getClientForAccount(account.id), {
            context: CONTEXT,
            accountId: account.id,
          });
          await fetchChatsFromApi(dialogsClient, cacheDb);
        }
        const allowed = await allowedChatIds(account.id);
        targets = chatsCache
          .list({ unread: true, limit: -1 })
          .filter((row) => allowed === null || allowed.has(Number(row.chat_id)))
          .map((row) => ({
            chat: chatInfo(Number(row.chat_id), row),
            state: {
              unreadCount: row.unread_count ?? 0,
              readInboxMaxId: row.read_inbox_max_id ?? 0,
            },
            resolve: () => resolveHistoryChat(client, row.chat_id, deps),
          }));
      }

      success(await readUnread(cacheDb, client, targets, limit, fresh));
    } catch (err) {
      reportHistoryError(err, "read unread messages");
    }
  },
});
