import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const pkg = await Bun.file("package.json").json();
const isWindows = process.platform === "win32";
const outputBase = join("dist", "tg-test");
const OUTPUT = isWindows ? `${outputBase}.exe` : outputBase;
const RUN_PATH = isWindows ? OUTPUT : `./${OUTPUT}`;

async function runBinary(args: string[]): Promise<string> {
  const proc = Bun.spawn([RUN_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Binary failed (${args.join(" ")}): ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

// Clean up previous test build
if (existsSync(OUTPUT)) {
  unlinkSync(OUTPUT);
}

try {
  // Build current platform
  console.log("Building for current platform...");
  await $`bun build ./src/index.ts --compile --outfile ${OUTPUT}`;

  // Verify output exists
  if (!existsSync(OUTPUT)) {
    throw new Error("Build output not found");
  }

  // Verify it runs
  console.log("Verifying binary...");
  const result = await runBinary(["--version"]);
  if (!result.includes(pkg.version)) {
    throw new Error(`Version mismatch: expected ${pkg.version}, got ${result.trim()}`);
  }

  // Verify help works
  await runBinary(["--help"]);

  console.log(`Build test passed! Version: ${pkg.version}`);
} finally {
  if (existsSync(OUTPUT)) {
    unlinkSync(OUTPUT);
  }
}
