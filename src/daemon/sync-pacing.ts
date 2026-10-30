/**
 * How fast an account's sync jobs start (#133). Each job makes one
 * `messages.getHistory` call, so the interval between job starts is the
 * account's call rate.
 *
 * While history is due (a first pass, or a backfill `tg chats sync` turned
 * on), the account runs at an adaptive pace: it starts at 0.7 calls/s,
 * speeds up by 0.05 calls/s after every 30 calls without a FLOOD_WAIT, up
 * to `maxCallsPerSecond`, and halves the pace on a FLOOD_WAIT, waiting it
 * out first. With no history due it starts a job at most every
 * `calmIntervalMs`. Intervals count from each job's start, so a slow page
 * doesn't stretch them. In memory: a restart starts at 0.7 again.
 */
import type { DaemonPacing } from '../db/daemon-status'

/** The pacing config.json sets (`sync.pacing.*`), read at daemon start */
export interface SyncPacingConfig {
  /** The fastest pace while history is due, in calls per second */
  maxCallsPerSecond: number
  /** The interval between job starts with no history due, in ms */
  calmIntervalMs: number
}

export const DEFAULT_SYNC_PACING: SyncPacingConfig = {
  maxCallsPerSecond: 0.9,
  calmIntervalMs: 3000,
}

/** The pace history starts at: a probe ran 150 s at 0.7/s with no FLOOD_WAIT */
export const PACING_START_CALLS_PER_SECOND = 0.7
/** How much the pace grows after a clean run */
export const PACING_STEP_CALLS_PER_SECOND = 0.05
/** Calls without a FLOOD_WAIT that make a clean run */
export const PACING_CLEAN_RUN_CALLS = 30

export type SyncPacingMode = DaemonPacing['mode']

export class SyncPacer {
  private readonly maxRate: number
  /** Never slower than the calm interval, nor faster than the cap */
  private readonly minRate: number
  private readonly calmIntervalMs: number
  /** The pace while history is due, in calls per second */
  private rate: number
  private mode: SyncPacingMode = 'calm'
  private lastStartAt: number | null = null
  /** No job starts before this: the end of a FLOOD_WAIT and one interval */
  private notBefore = 0
  private cleanCalls = 0
  private floodWaits = 0

  constructor(config: SyncPacingConfig = DEFAULT_SYNC_PACING) {
    this.maxRate = config.maxCallsPerSecond
    this.calmIntervalMs = config.calmIntervalMs
    this.minRate = Math.min(1000 / config.calmIntervalMs, this.maxRate)
    this.rate = Math.min(PACING_START_CALLS_PER_SECOND, this.maxRate)
  }

  /** The interval between job starts in the current mode, in ms */
  intervalMs(): number {
    return this.mode === 'history'
      ? Math.round(1000 / this.rate)
      : this.calmIntervalMs
  }

  /** Whether history is due; the scheduler asks before each pick */
  setHistoryDue(due: boolean): void {
    this.mode = due ? 'history' : 'calm'
  }

  /** When the next job may start */
  nextStartAt(): number {
    const paced =
      this.lastStartAt === null ? 0 : this.lastStartAt + this.intervalMs()
    return Math.max(paced, this.notBefore)
  }

  isDue(now: number): boolean {
    return now >= this.nextStartAt()
  }

  /** A job started, or a pick failed and the account waits an interval */
  recordStart(now: number): void {
    this.lastStartAt = now
  }

  /**
   * A job's call went through without a FLOOD_WAIT. Returns the new history
   * pace when this call ended a clean run and sped it up, else null.
   */
  recordCleanCall(): number | null {
    if (this.mode !== 'history') return null
    this.cleanCalls++
    if (this.cleanCalls < PACING_CLEAN_RUN_CALLS) return null
    this.cleanCalls = 0
    const faster = Math.min(
      this.maxRate,
      this.rate + PACING_STEP_CALLS_PER_SECOND,
    )
    if (faster === this.rate) return null
    this.rate = faster
    return faster
  }

  /**
   * Telegram answered a sync page (messages.getHistory) with
   * FLOOD_WAIT_<seconds>, in any mode: half the pace, and no job until the wait and one interval at
   * the new pace are over. mtcute's flood waiter retries the call when the
   * wait ends, so the next job comes one interval after that retry. Returns
   * the new history pace.
   */
  recordFloodWait(now: number, seconds: number): number {
    this.floodWaits++
    this.cleanCalls = 0
    this.rate = Math.max(this.minRate, this.rate / 2)
    const waitEnd = now + Math.max(1, seconds) * 1000
    this.notBefore = Math.max(
      this.notBefore,
      waitEnd + Math.round(1000 / this.rate),
    )
    return this.rate
  }

  /** What the daemon writes to the account's daemon_status every tick */
  snapshot(): DaemonPacing {
    return {
      mode: this.mode,
      targetCallsPerSecond: 1000 / this.intervalMs(),
      floodWaits: this.floodWaits,
    }
  }
}

/** A pace for logs and `tg status`: calls per second, two decimals */
export function formatPace(callsPerSecond: number): string {
  return callsPerSecond.toFixed(2)
}

export function createSyncPacer(config?: SyncPacingConfig): SyncPacer {
  return new SyncPacer(config)
}
