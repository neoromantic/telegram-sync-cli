import { MtInvalidPeerTypeError, type TelegramClient, type tl } from "@mtcute/bun";
import { randomLong, toInputChannel, toInputUser } from "@mtcute/bun/utils.js";
import { defineCommand } from "citty";

import { createChatsCache } from "../db/chats-cache";
import { createUsersCache } from "../db/users-cache";
import { getClientForAccount } from "../services/telegram";
import { ErrorCodes } from "../types";
import { openAccountCache } from "../utils/account-cache";
import { ACCOUNT_SELECTOR_DESCRIPTION } from "../utils/account-selector";
import { mergeArgs, spacedFlagValues } from "../utils/args";
import { toLong } from "../utils/long";
import { error, raw, success } from "../utils/output";
import {
  reportConfigOrRateLimitError,
  wrapClientCallWithRateLimits,
} from "../utils/telegram-rate-limits";
import {
  AmbiguousPeerError,
  createDmLookup,
  InvalidPeerError,
  resolvePeer,
} from "./send/peer-resolver";

const TRANSIENT_TELEGRAM_CODES: ReadonlySet<unknown> = new Set([500, -503]);

/**
 * Generic API command
 *
 * Usage:
 *   tg api account.checkUsername --username myuser
 *   tg api messages.getHistory --peer @username --limit 10
 *   tg api users.getFullUser --id me
 *   tg api contacts.getContacts
 *   tg api messages.sendMessage --json '{"peer": "@user", "message": "Hello"}'
 */
export const apiCommand = defineCommand({
  meta: {
    name: "api",
    description:
      "Call any Telegram API method directly. Pass its arguments after the method as --name value or --name=value",
  },
  args: {
    method: {
      type: "positional",
      description: "Telegram API method name (e.g., account.checkUsername)",
      required: true,
    },
    json: {
      type: "string",
      alias: "j",
      description: "JSON string with method arguments",
    },
    account: {
      type: "string",
      alias: "a",
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
    raw: {
      type: "boolean",
      alias: "r",
      description: "Output raw response without wrapping",
      default: false,
    },
  },
  async run({ args, rawArgs }) {
    const method = args.method as string;

    if (!method.includes(".")) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid method name: "${method}". Expected format: namespace.methodName (e.g., account.checkUsername)`,
      );
    }

    const { account, db } = openAccountCache(args.account);
    let client: TelegramClient | undefined;

    try {
      const apiClient = wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: "cli:api",
        accountId: account.id,
      });
      client = apiClient;

      const cliOnlyArgs = [
        "method",
        "json",
        "j",
        "account",
        "a",
        "raw",
        "r",
        "format",
        "f",
        "verbose",
        "v",
        "quiet",
        "q",
        "_",
        "--",
      ];
      const apiArgs: Record<string, unknown> = {};
      const spaced = spacedFlagValues(rawArgs, method, args as Record<string, unknown>);

      for (const [key, value] of Object.entries(args)) {
        if (cliOnlyArgs.includes(key) || /^[\d.]/.test(key)) continue;
        apiArgs[key] = spaced.get(key) ?? value;
      }

      const params = mergeArgs(apiArgs, args.json as string | undefined);

      const usersCache = createUsersCache(db);
      const chatsCache = createChatsCache(db);
      const dms = createDmLookup(db);
      const request = await buildApiRequest(method, params, async (id) => {
        const peer = await resolvePeer(apiClient, id, usersCache, chatsCache, dms);
        return peer.inputPeer;
      });
      const result = await client.call(request);
      await closeClient(client);

      if (args.raw) {
        raw(JSON.stringify(result, replacer, 2));
      } else {
        success({
          method,
          result,
        });
      }
    } catch (err) {
      await closeClient(client);
      reportConfigOrRateLimitError(err);
      if (
        err instanceof InvalidPeerError ||
        err instanceof AmbiguousPeerError ||
        err instanceof MtInvalidPeerTypeError
      ) {
        error(ErrorCodes.INVALID_ARGS, err.message, { method });
      }
      const message = err instanceof Error ? err.message : "Unknown error";

      const code = ErrorCodes.TELEGRAM_ERROR;
      const details: Record<string, unknown> = { method };

      if (err && typeof err === "object" && "code" in err) {
        const codeValue = (err as { code?: unknown }).code;
        if (typeof codeValue === "string" || typeof codeValue === "number") {
          details.telegramErrorCode = codeValue;
        }
      }

      error(
        code,
        `API call failed: ${message}`,
        details,
        undefined,
        TRANSIENT_TELEGRAM_CODES.has(details.telegramErrorCode),
      );
    }
  },
});

interface TlArgument {
  name: string;
  type: string;
  typeModifiers?: { predicate?: string; isVector?: boolean };
}

interface TlEntry {
  kind: "class" | "method";
  name: string;
  arguments: TlArgument[];
}

type ResolveInputPeer = (identifier: string) => Promise<tl.TypeInputPeer>;

const PEER_INPUTS: Record<string, (peer: tl.TypeInputPeer, identifier: string) => unknown> = {
  InputPeer: (peer) => peer,
  InputUser: toInputUser,
  InputChannel: toInputChannel,
};

/**
 * The request for `method`, typed by mtcute's TL schema. A chat given as a
 * string or number where the method takes an InputPeer, InputUser or
 * InputChannel resolves the way `tg send --to` does; a long given as a
 * number or decimal string becomes a Long. A required int or long left out
 * is 0, a required randomId a random Long and a required offsetPeer
 * inputPeerEmpty. Objects go as given, and so does every argument of a
 * method the schema doesn't know.
 */
export async function buildApiRequest(
  method: string,
  params: Record<string, unknown>,
  resolve: ResolveInputPeer,
): Promise<tl.RpcMethod> {
  const { default: schema } = await import("@mtcute/core/tl/api-schema.json");
  const entry = (schema.e as TlEntry[]).find((e) => e.kind === "method" && e.name === method);
  const request: Record<string, unknown> = { _: method, ...params };
  for (const arg of entry?.arguments ?? []) {
    if (arg.type === "#") continue;
    const key = arg.name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    const value = request[key];
    const { predicate, isVector } = arg.typeModifiers ?? {};
    if (value !== undefined) {
      request[key] =
        isVector && Array.isArray(value)
          ? await Promise.all(value.map((v) => toTlValue(arg.type, v, resolve)))
          : await toTlValue(arg.type, value, resolve);
    } else if (!predicate && !isVector) {
      const zero = zeroValue(arg);
      if (zero !== undefined) request[key] = zero;
    }
  }
  return request as unknown as tl.RpcMethod;
}

async function toTlValue(
  type: string,
  value: unknown,
  resolve: ResolveInputPeer,
): Promise<unknown> {
  if (typeof value !== "string" && typeof value !== "number") return value;
  const text = String(value);
  if (type === "long") return /^-?\d+$/.test(text) ? toLong(text) : value;
  const toInput = PEER_INPUTS[type];
  return toInput ? toInput(await resolve(text), text) : value;
}

function zeroValue({ name, type }: TlArgument): unknown {
  if (type === "int") return 0;
  if (type === "long") return name === "random_id" ? randomLong() : toLong(0);
  if (type === "InputPeer" && name === "offset_peer") {
    return { _: "inputPeerEmpty" };
  }
  return undefined;
}

async function closeClient(client: TelegramClient | undefined): Promise<void> {
  await client?.destroy().catch(() => {});
}

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}
