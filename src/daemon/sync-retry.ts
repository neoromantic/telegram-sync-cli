import { calculateReconnectDelay } from "./daemon-utils";
import type { ReconnectConfig } from "./types";

/**
 * Backoff for failed sync jobs: 1, 2, 4 and 8 minutes, and the fifth failure
 * is final. Not a config.json key: it isn't a TTL.
 */
export const SYNC_RETRY_CONFIG: ReconnectConfig = {
  initialDelayMs: 60_000,
  backoffMultiplier: 2,
  maxDelayMs: 8 * 60_000,
  maxAttempts: 5,
};

/** The wait before the next try of a job that failed `failures` times */
export function retryDelayMs(failures: number) {
  return calculateReconnectDelay(failures, SYNC_RETRY_CONFIG);
}
