import { EVENTS_ENV, type Handoff } from "./background";
import { createTgTelemetry } from "./index";

const SEND_MS = 3500;
const GIVE_UP_MS = 5000;

export async function sendHandoff(json: string | undefined): Promise<never> {
  setTimeout(() => process.exit(0), GIVE_UP_MS);
  try {
    const handoff = JSON.parse(json ?? "") as Handoff;
    const env = { ...process.env, [EVENTS_ENV]: undefined };
    const features = handoff.calls.flatMap(([name, arg]) => (name === "feature" ? [arg] : []));
    const t = createTgTelemetry({
      channel: handoff.channel,
      env,
      tty: handoff.tty,
      features,
    });
    for (const call of handoff.calls) {
      if (call[0] === "started") t.started();
      else if (call[0] === "feature") t.feature(call[1]);
      else t.error(call[1]);
    }
    await t.flush(SEND_MS);
  } catch {}
  process.exit(0);
}

if (import.meta.main) void sendHandoff(process.env[EVENTS_ENV]);
