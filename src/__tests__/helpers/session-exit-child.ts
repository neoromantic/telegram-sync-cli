/**
 * A real mtcute client on a session file in <dir>, with the daemon's
 * platform, for daemon-platform.test.ts. prepare() opens the session file
 * and needs no network. Run as `bun --no-env-file <this file> <mode> <dir>`:
 *
 * - signal: SIGTERM arrives, then a session write and destroy()
 * - exit: a queued session write, then process.exit(1) without destroy()
 * - read: reopen the session file and print what it holds
 *
 * Each mode prints one line of JSON.
 */
import { join } from 'node:path'
import { TelegramClient } from '@mtcute/bun'
import { daemonPlatform } from '../../daemon/daemon-platform'

const [mode, dir] = process.argv.slice(2)
if (!mode || !dir) {
  throw new Error('Usage: session-exit-child.ts <signal|exit|read> <dir>')
}

const client = new TelegramClient({
  apiId: 1,
  apiHash: 'test',
  storage: join(dir, 'session.db'),
  platform: daemonPlatform,
  logLevel: 1,
})
await client.prepare()

async function attempt(errors: string[], label: string, fn: () => unknown) {
  try {
    await fn()
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : err}`)
  }
}

if (mode === 'signal') {
  // Signal listeners mtcute added, before the daemon adds its own
  const mtcuteListeners = {
    SIGTERM: process.listenerCount('SIGTERM'),
    SIGINT: process.listenerCount('SIGINT'),
  }
  let handlerRuns = 0
  const signalled = new Promise<void>((resolve) => {
    process.on('SIGTERM', () => {
      handlerRuns++
      resolve()
    })
  })
  process.kill(process.pid, 'SIGTERM')
  await signalled
  // A signal sent again would arrive in this time
  await Bun.sleep(50)

  const errors: string[] = []
  await attempt(errors, 'store', () =>
    client.storage.self.store({
      userId: 4242,
      isBot: false,
      isPremium: false,
      usernames: [],
    }),
  )
  await attempt(errors, 'setChannelPts', () =>
    client.storage.updates.setChannelPts(1, 31337),
  )
  await attempt(errors, 'destroy', () => client.destroy())
  console.log(JSON.stringify({ mtcuteListeners, handlerRuns, errors }))
} else if (mode === 'exit') {
  await client.storage.updates.setChannelPts(1, 4242)
  console.log(JSON.stringify({ queued: true }))
  process.exit(1)
} else if (mode === 'read') {
  const pts = await client.storage.updates.getChannelPts(1)
  const self = await client.storage.self.fetch()
  await client.destroy()
  console.log(JSON.stringify({ pts, selfUserId: self?.userId ?? null }))
} else {
  throw new Error(`Unknown mode: ${mode}`)
}
