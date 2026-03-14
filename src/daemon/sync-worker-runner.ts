import { formatError } from './daemon-utils'
import type { RealSyncWorker } from './sync-worker-real'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function handleWorkerResult(
  result: Awaited<ReturnType<RealSyncWorker['runOnceReal']>>,
  options: {
    pollIntervalMs: number
    onRateLimited?: (waitSeconds: number) => void
    logger: {
      debug(message: string): void
      info(message: string): void
      warn(message: string): void
      error(message: string): void
    }
  },
): Promise<number> {
  const { pollIntervalMs, onRateLimited, logger } = options

  if (result === null) {
    return pollIntervalMs
  }

  if (result.rateLimited) {
    const waitSeconds = result.waitSeconds ?? 30
    logger.warn(`Rate limited, waiting ${waitSeconds}s`)
    onRateLimited?.(waitSeconds)
    return waitSeconds * 1000
  }

  if (result.success) {
    logger.debug(`Job completed: ${result.messagesFetched} messages fetched`)
  } else if (result.error) {
    logger.error(`Job failed: ${result.error}`)
  }

  return 100
}

/**
 * Create a sync worker runner that continuously processes jobs
 */
export function createSyncWorkerRunner(
  worker: RealSyncWorker,
  options: {
    pollIntervalMs?: number
    shouldStop?: () => boolean
    onRateLimited?: (waitSeconds: number) => void
    logger?: {
      debug(message: string): void
      info(message: string): void
      warn(message: string): void
      error(message: string): void
    }
  } = {},
) {
  const pollIntervalMs = options.pollIntervalMs ?? 1000
  const shouldStop = options.shouldStop ?? (() => false)
  const onRateLimited = options.onRateLimited
  const logger = options.logger ?? console

  let running = false

  return {
    /**
     * Start the worker loop
     */
    async start(): Promise<void> {
      if (running) return
      running = true

      logger.info('Sync worker started')

      while (running && !shouldStop()) {
        try {
          const result = await worker.runOnceReal()
          const delayMs = await handleWorkerResult(result, {
            pollIntervalMs,
            onRateLimited,
            logger,
          })
          await sleep(delayMs)
        } catch (err) {
          logger.error(`Worker error: ${formatError(err)}`)
          // Wait before retrying
          await sleep(pollIntervalMs)
        }
      }

      logger.info('Sync worker stopped')
    },

    /**
     * Stop the worker loop
     */
    stop(): void {
      running = false
    },

    /**
     * Check if running
     */
    isRunning(): boolean {
      return running
    },
  }
}
