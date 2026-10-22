/**
 * Generic API command - call any Telegram API method
 *
 * This enables full access to Telegram's API without manually
 * mapping every method to a CLI command.
 */
import type { TelegramClient, tl } from '@mtcute/bun'
import { defineCommand } from 'citty'

import { ConfigError } from '../config'
import { getClientForAccount } from '../services/telegram'
import { ErrorCodes } from '../types'
import { openAccountCache } from '../utils/account-cache'
import { ACCOUNT_SELECTOR_DESCRIPTION } from '../utils/account-selector'
import { mergeArgs } from '../utils/args'
import { error, raw, success } from '../utils/output'
import {
  isRateLimitError,
  wrapClientCallWithRateLimits,
} from '../utils/telegram-rate-limits'

/**
 * Generic API command
 *
 * Usage:
 *   tg api account.checkUsername --username myuser
 *   tg api messages.getHistory --peer @username --limit 10
 *   tg api contacts.getContacts
 *   tg api messages.sendMessage --json '{"peer": "@user", "message": "Hello"}'
 */
export const apiCommand = defineCommand({
  meta: {
    name: 'api',
    description: 'Call any Telegram API method directly',
  },
  args: {
    method: {
      type: 'positional',
      description: 'Telegram API method name (e.g., account.checkUsername)',
      required: true,
    },
    json: {
      type: 'string',
      alias: 'j',
      description: 'JSON string with method arguments',
    },
    account: {
      type: 'string',
      alias: 'a',
      description: ACCOUNT_SELECTOR_DESCRIPTION,
    },
    raw: {
      type: 'boolean',
      alias: 'r',
      description: 'Output raw response without wrapping',
      default: false,
    },
  },
  async run({ args }) {
    const method = args.method as string

    // Validate method name format
    if (!method.includes('.')) {
      error(
        ErrorCodes.INVALID_ARGS,
        `Invalid method name: "${method}". Expected format: namespace.methodName (e.g., account.checkUsername)`,
      )
    }

    // Rate limits are kept in the account's cache
    const { account } = openAccountCache(args.account)
    let client: TelegramClient | undefined

    try {
      client = wrapClientCallWithRateLimits(getClientForAccount(account.id), {
        context: 'cli:api',
        accountId: account.id,
      })

      // Build request parameters
      // Remove known CLI args, keep the rest as API params
      const cliOnlyArgs = [
        'method',
        'json',
        'j',
        'account',
        'a',
        'raw',
        'r',
        '_',
        '--',
      ]
      const apiArgs: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(args)) {
        if (!cliOnlyArgs.includes(key)) {
          apiArgs[key] = value
        }
      }

      // Merge with JSON input if provided
      const params = mergeArgs(apiArgs, args.json as string | undefined)

      // Make the API call
      const request = { _: method, ...params } as tl.RpcMethod
      const result = await client.call(request)
      await closeClient(client)

      // Output result
      if (args.raw) {
        raw(JSON.stringify(result, replacer, 2))
      } else {
        success({
          method,
          result,
        })
      }
    } catch (err) {
      await closeClient(client)
      if (err instanceof ConfigError) {
        error(ErrorCodes.INVALID_ARGS, err.message, { issues: err.issues })
      }
      if (isRateLimitError(err)) {
        error(
          ErrorCodes.RATE_LIMITED,
          `Rate limited for ${err.method}. Wait ${err.waitSeconds}s before retrying.`,
          { method: err.method, wait_seconds: err.waitSeconds },
        )
      }
      const message = err instanceof Error ? err.message : 'Unknown error'

      // Try to extract Telegram error code
      const code = ErrorCodes.TELEGRAM_ERROR
      const details: Record<string, unknown> = { method }

      if (err && typeof err === 'object' && 'code' in err) {
        const codeValue = (err as { code?: unknown }).code
        if (typeof codeValue === 'string' || typeof codeValue === 'number') {
          details.telegramErrorCode = codeValue
        }
      }

      error(code, `API call failed: ${message}`, details)
    }
  },
})

/**
 * Close the client before the output exits. mtcute's connection would keep
 * the process alive, and destroy() saves the session. The result stands
 * even if closing fails.
 */
async function closeClient(client: TelegramClient | undefined): Promise<void> {
  await client?.destroy().catch(() => {})
}

/**
 * Custom JSON replacer to handle BigInt values
 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  return value
}
