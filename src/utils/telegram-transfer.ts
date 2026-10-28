/**
 * The client file transfers (upload.getFile, upload.saveFilePart) run on.
 *
 * mtcute sends every getFile with `floodSleepThreshold: Infinity`, so it
 * would sleep through any FLOOD_WAIT and only a stall timeout would end the
 * download. Through this facade it sleeps through short waits only (such
 * as the FLOOD_PREMIUM_WAIT of a download without Premium); a longer one
 * reaches the rate-limit wrapper (telegram-rate-limits.ts), which records
 * it for the account and throws RateLimitError.
 */
import type { TelegramClient } from '@mtcute/bun'

/** Flood waits up to this long are slept through during a transfer */
export const MEDIA_FLOOD_SLEEP_MS = 10_000

/**
 * The client with every call's `floodSleepThreshold` set to
 * MEDIA_FLOOD_SLEEP_MS; anything else is the client's own. Pass the free
 * transfer functions (`downloadAsIterable`, `uploadFile` from
 * `@mtcute/bun/methods.js`) this facade of the rate-limited client: the
 * client's own methods call an inner client that bypasses the wrapper.
 */
export function transferClient(client: TelegramClient): TelegramClient {
  const facade = Object.create(client) as TelegramClient
  facade.call = ((
    request: Parameters<TelegramClient['call']>[0],
    options?: Parameters<TelegramClient['call']>[1],
  ) =>
    client.call(request, {
      ...options,
      floodSleepThreshold: MEDIA_FLOOD_SLEEP_MS,
    })) as TelegramClient['call']
  return facade
}
