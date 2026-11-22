import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

import { ErrorCodes } from "../../types";
import { MediaError } from "./errors";

const active = new Set<number>();
const windows = process.platform === "win32";

function killTree(pid: number) {
  if (windows) {
    const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(executable, ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", timeout: 3000 });
  }
  try {
    process.kill(windows ? pid : -pid, "SIGKILL");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

export function stopLocalProcesses() {
  for (const pid of active) killTree(pid);
}

/** No shell. Keep only the diagnostic tail, including for a noisy or stuck runner. */
export async function runLocalProcess(
  argv: string[],
  signal: AbortSignal,
  observeStderr?: (chunk: string) => void,
) {
  signal.throwIfAborted();
  const [program, ...args] = argv;
  const child = spawn(program!, args, {
    stdio: ["ignore", "ignore", "pipe"],
    detached: !windows,
    windowsHide: true,
  });
  const pid = child.pid;
  if (pid) active.add(pid);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const interrupt = () => {
    if (!pid) return;
    if (windows) return killTree(pid);
    child.kill("SIGTERM");
    deadline = setTimeout(() => killTree(pid), 750);
  };
  signal.addEventListener("abort", interrupt, { once: true });
  let stderr = Buffer.alloc(0);
  child.stderr.on("data", (chunk: Buffer) => {
    observeStderr?.(chunk.toString());
    stderr = Buffer.concat([stderr, chunk.subarray(-8192)]).subarray(-8192);
  });
  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    signal.throwIfAborted();
    return { exitCode, stderr: stderr.toString() };
  } catch (err) {
    signal.throwIfAborted();
    throw new MediaError(ErrorCodes.GENERAL_ERROR, `Could not run ${program}`, {
      program,
      reason: err instanceof Error ? err.message : String(err),
    });
  } finally {
    signal.removeEventListener("abort", interrupt);
    clearTimeout(deadline);
    if (pid) {
      if (signal.aborted) killTree(pid);
      active.delete(pid);
    }
  }
}
