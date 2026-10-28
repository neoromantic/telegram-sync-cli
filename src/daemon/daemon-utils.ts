import { DEFAULT_RECONNECT_CONFIG, type ReconnectConfig } from './types'

export function calculateReconnectDelay(
  attemptNumber: number,
  config: ReconnectConfig = DEFAULT_RECONNECT_CONFIG,
): number {
  return Math.min(
    config.initialDelayMs * config.backoffMultiplier ** (attemptNumber - 1),
    config.maxDelayMs,
  )
}

/**
 * The reason a daemon stop aborts the requests it waits on. Only
 * `requestShutdown` creates it, so a request that ends with it was cut short
 * by the stop, not by a fault.
 */
export class DaemonStopError extends Error {
  constructor() {
    super('The daemon is stopping')
    this.name = 'DaemonStopError'
  }
}

export function isDaemonStopError(err: unknown): err is DaemonStopError {
  return err instanceof DaemonStopError
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message
  }
  if (typeof err === 'string') {
    return err
  }
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}

export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
