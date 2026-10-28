/**
 * The transfer facade: every call sleeps through flood waits up to 10 s
 * only, and everything else is the client's own
 */
import { describe, expect, it } from 'bun:test'
import type { TelegramClient } from '@mtcute/bun'

import {
  MEDIA_FLOOD_SLEEP_MS,
  transferClient,
} from '../utils/telegram-transfer'

function fakeClient() {
  const calls: Array<{ request: unknown; options: unknown }> = []
  const client = {
    marker: 'own',
    call: async (request: unknown, options?: unknown) => {
      calls.push({ request, options })
      return { ok: true }
    },
    getPrimaryDcId() {
      return (this as { marker: string }).marker
    },
  }
  return { client: client as unknown as TelegramClient, calls }
}

describe('transferClient', () => {
  it('sets floodSleepThreshold on every call and keeps other options', async () => {
    const { client, calls } = fakeClient()
    const facade = transferClient(client)
    const request = { _: 'upload.getFile' } as Parameters<
      TelegramClient['call']
    >[0]

    expect(
      await facade.call(request, { floodSleepThreshold: Infinity, dcId: 4 }),
    ).toEqual({ ok: true })
    await facade.call(request)

    expect(MEDIA_FLOOD_SLEEP_MS).toBe(10_000)
    expect(calls).toEqual([
      { request, options: { floodSleepThreshold: 10_000, dcId: 4 } },
      { request, options: { floodSleepThreshold: 10_000 } },
    ])
  })

  it("reads the rest from the client and leaves the client's call alone", async () => {
    const { client, calls } = fakeClient()
    const facade = transferClient(client)

    expect(
      (facade as unknown as { getPrimaryDcId(): string }).getPrimaryDcId(),
    ).toBe('own')
    await client.call({ _: 'help.getConfig' } as Parameters<
      TelegramClient['call']
    >[0])
    expect(calls[0]?.options).toBeUndefined()
  })
})
