/**
 * A request that waits out a FLOOD_WAIT the way mtcute's flood waiter does,
 * for tests of the daemon stop (#64): it sleeps until the request's
 * `abortSignal` aborts, then rejects with the signal's reason.
 *
 * Like mtcute's `sleepWithAbort`, it only listens for the abort, so a signal
 * that is already aborted never wakes it. A guard timer rejects instead, so
 * a request without a working signal fails fast rather than hanging.
 */
export interface FloodWaitOptions {
  /**
   * Called on a timer once the wait has started, never synchronously: a stop
   * raised while the wait is being set up would start it with an aborted
   * signal, which mtcute ignores
   */
  onWait?: () => void
  /** How long the wait may last before it fails the test */
  guardMs?: number
}

export function waitLikeFloodWait(
  params: { abortSignal?: AbortSignal } | undefined,
  { onWait, guardMs = 1500 }: FloodWaitOptions = {},
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const signal = params?.abortSignal
    const timers: ReturnType<typeof setTimeout>[] = []
    const settle = (reason: unknown) => {
      for (const timer of timers) clearTimeout(timer)
      reject(reason)
    }

    signal?.addEventListener('abort', () => settle(signal.reason), {
      once: true,
    })
    if (onWait) timers.push(setTimeout(onWait, 5))
    timers.push(
      setTimeout(
        () => settle(new Error('FLOOD_WAIT was not cut short')),
        guardMs,
      ),
    )
  })
}
