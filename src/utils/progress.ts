import { formatBytes } from "./formatting";
import { getOutputFormat } from "./output";

interface ProgressStream {
  isTTY?: boolean;
  write(text: string): unknown;
}

/**
 * A progress callback that rewrites one line, `<label> 42% 12.3 MB / 29.0 MB`,
 * and ends it once `done` reaches `total`. Undefined when nobody watches.
 */
export function createProgress(label: string, stream: ProgressStream = process.stderr) {
  if (!stream.isTTY || getOutputFormat() === "quiet") {
    const result: ((done: number, total: number) => void) | undefined = undefined;
    return result;
  }

  let finished = false;
  const result: ((done: number, total: number) => void) | undefined = (done, total) => {
    if (finished) return;
    const known = Number.isFinite(total) && total > 0;
    const text = known
      ? `${label} ${Math.floor((Math.min(done, total) / total) * 100)}% ${formatBytes(done)} / ${formatBytes(total)}`
      : `${label} ${formatBytes(done)}`;
    stream.write(`\r${text}\x1b[K`);
    if (known && done >= total) {
      finished = true;
      stream.write("\n");
    }
  };
  return result;
}
