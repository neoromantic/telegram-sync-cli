import { join } from "node:path";
import { TelegramClient } from "@mtcute/bun";
import { daemonPlatform } from "./daemon-platform";

const [mode, dir] = process.argv.slice(2);
if (!mode || !dir) {
  throw new Error("Usage: session-exit-child.ts <signal|exit|read> <dir>");
}

const client = new TelegramClient({
  apiId: 1,
  apiHash: "test",
  storage: join(dir, "session.db"),
  platform: daemonPlatform,
  logLevel: 1,
});
await client.prepare();

async function attempt(errors: string[], label: string, fn: () => unknown) {
  try {
    await fn();
  } catch (err) {
    errors.push(`${label}: ${err instanceof Error ? err.message : err}`);
  }
}

if (mode === "signal") {
  const mtcuteListeners = {
    SIGTERM: process.listenerCount("SIGTERM"),
    SIGINT: process.listenerCount("SIGINT"),
  };
  let handlerRuns = 0;
  const signalled = new Promise<void>((resolve) => {
    process.on("SIGTERM", () => {
      handlerRuns++;
      resolve();
    });
  });
  process.kill(process.pid, "SIGTERM");
  await signalled;

  const errors: string[] = [];
  await attempt(errors, "store", () =>
    client.storage.self.store({
      userId: 4242,
      isBot: false,
      isPremium: false,
      usernames: [],
    }),
  );
  await attempt(errors, "setChannelPts", () => client.storage.updates.setChannelPts(1, 31337));
  await attempt(errors, "destroy", () => client.destroy());
  console.log(JSON.stringify({ mtcuteListeners, handlerRuns, errors }));
} else if (mode === "exit") {
  await client.storage.updates.setChannelPts(1, 4242);
  console.log(JSON.stringify({ queued: true }));
  process.exit(1);
} else if (mode === "read") {
  const pts = await client.storage.updates.getChannelPts(1);
  const self = await client.storage.self.fetch();
  await client.destroy();
  console.log(JSON.stringify({ pts, selfUserId: self?.userId ?? null }));
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
