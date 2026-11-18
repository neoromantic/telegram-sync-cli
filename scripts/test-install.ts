import { $ } from "bun";

const pkg = await Bun.file("package.json").json();

async function runTg(args: string[]): Promise<string> {
  const proc = Bun.spawn(["tg", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`tg ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

async function testInstall() {
  console.log("Testing bun link installation...\n");

  await $`bun link`.quiet();

  try {
    const helpResult = await runTg(["--help"]);
    if (!helpResult.includes("tg")) {
      throw new Error("tg command not working after link");
    }
    console.log("  ✓ tg --help");

    const version = await runTg(["--version"]);
    if (!version.includes(pkg.version)) {
      throw new Error(`Version mismatch: expected ${pkg.version}, got ${version.trim()}`);
    }
    console.log(`  ✓ tg --version (${version.trim()})`);

    const commands = ["auth", "accounts", "contacts", "api"];
    for (const cmd of commands) {
      await runTg([cmd, "--help"]);
      console.log(`  ✓ tg ${cmd} --help`);
    }

    console.log("\nInstallation test passed!");
  } finally {
    await $`bun unlink`.quiet().catch(() => {});
  }
}

await testInstall();
