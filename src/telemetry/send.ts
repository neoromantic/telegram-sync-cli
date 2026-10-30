/**
 * The detached copy of tg that sends a run's usage stats (background.ts). It
 * replays the run's calls on the client, which reads telemetry.json and
 * sends what is due as before, waits for the requests (3 seconds each) and
 * exits. It runs no command and prints nothing.
 */
import { EVENTS_ENV, type Handoff } from './background'
import { createTgTelemetry } from './index'

/** The client gives each request 3 seconds */
const SEND_MS = 3500
/** Whatever happens, this copy is gone by then */
const GIVE_UP_MS = 5000

export async function sendHandoff(json: string | undefined): Promise<never> {
  setTimeout(() => process.exit(0), GIVE_UP_MS)
  try {
    const handoff = JSON.parse(json ?? '') as Handoff
    const env = { ...process.env, [EVENTS_ENV]: undefined }
    const features = handoff.calls.flatMap(([name, arg]) =>
      name === 'feature' ? [arg] : [],
    )
    const t = createTgTelemetry({
      channel: handoff.channel,
      env,
      tty: handoff.tty,
      features,
    })
    for (const call of handoff.calls) {
      if (call[0] === 'started') t.started()
      else if (call[0] === 'feature') t.feature(call[1])
      else t.error(call[1])
    }
    await t.flush(SEND_MS)
  } catch {
    // Usage stats never fail tg
  }
  process.exit(0)
}

if (import.meta.main) void sendHandoff(process.env[EVENTS_ENV])
