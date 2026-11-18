import { existsSync, mkdirSync } from "node:fs";
import { $ } from "bun";

// Read version from package.json
const pkg = await Bun.file("package.json").json();

const targets = [
  { target: "bun-darwin-arm64", output: "tg-darwin-arm64" },
  { target: "bun-darwin-x64", output: "tg-darwin-x64" },
  { target: "bun-linux-x64", output: "tg-linux-x64" },
  { target: "bun-linux-arm64", output: "tg-linux-arm64" },
  { target: "bun-windows-x64", output: "tg-windows-x64.exe" },
] as const;

// Ensure dist directory exists
if (!existsSync("dist")) {
  mkdirSync("dist");
}

console.log(`Building telegram-sync-cli v${pkg.version} for all platforms...\n`);

const results: { target: string; success: boolean; error?: string }[] = [];

for (const { target, output } of targets) {
  process.stdout.write(`  ${target}... `);
  try {
    await $`bun build ./src/index.ts --compile --minify --target=${target} --outfile dist/${output}`.quiet();
    console.log("✓");
    results.push({ target, success: true });
  } catch (err) {
    console.log("✗");
    results.push({ target, success: false, error: String(err) });
  }
}

// Summary
const succeeded = results.filter((r) => r.success).length;
const failed = results.filter((r) => !r.success).length;

console.log(`\nBuild complete: ${succeeded} succeeded, ${failed} failed`);

if (failed > 0) {
  console.log("\nFailed builds:");
  for (const r of results.filter((r) => !r.success)) {
    console.log(`  - ${r.target}: ${r.error}`);
  }
  process.exit(1);
}
