/**
 * Transfer progress on stderr, for a person at a terminal: never on stdout,
 * and nothing when stderr is not a TTY or the output is quiet
 */
import { formatBytes } from './formatting'
import { getOutputFormat } from './output'

interface ProgressStream {
  isTTY?: boolean
  write(text: string): unknown
}

/**
 * A progress callback that rewrites one line, `<label> 42% 12.3 MB / 29.0 MB`,
 * and ends it once `done` reaches `total`. Undefined when nobody watches.
 */
export function createProgress(
  label: string,
  stream: ProgressStream = process.stderr,
): ((done: number, total: number) => void) | undefined {
  if (!stream.isTTY || getOutputFormat() === 'quiet') return undefined

  let finished = false
  return (done, total) => {
    if (finished) return
    const known = Number.isFinite(total) && total > 0
    const text = known
      ? `${label} ${Math.floor((Math.min(done, total) / total) * 100)}% ${formatBytes(done)} / ${formatBytes(total)}`
      : `${label} ${formatBytes(done)}`
    // \x1b[K clears what a longer line left
    stream.write(`\r${text}\x1b[K`)
    if (known && done >= total) {
      finished = true
      stream.write('\n')
    }
  }
}
