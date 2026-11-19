// WARNING: managed by devkit v1: edit in https://github.com/neoromantic/devkit/blob/main/templates/telemetry/telemetry.ts, spec https://github.com/neoromantic/devkit/blob/main/docs/standards/telemetry.md
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import { basename, dirname, join } from "node:path";

const ENDPOINT = "https://usage.sergeybaus.com/i/v0/e/";
const API_KEY = "phc_np7sxHvzFH1HDTlQdMaqRDrpOVZ0xytnSDxyCMBwNO9"; // WARNING: PostHog's public, write-only key, not a secret. gitleaks:allow
const LIB = "devkit-telemetry";
const LIB_VERSION = "1";
const NOTICE_VERSION = 1;
const NOTICE_URL = "https://usage.sergeybaus.com";
const CI_VARS = [
  "GITHUB_ACTIONS",
  "GITLAB_CI",
  "BUILDKITE",
  "CIRCLECI",
  "TF_BUILD",
  "JENKINS_URL",
  "TEAMCITY_VERSION",
  "CODEBUILD_BUILD_ID",
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Mode =
  | "interactive"
  | "agent"
  | "script"
  | "scheduled"
  | "daemon"
  | "app"
  | "plugin"
  | "server";
export type Channel =
  | "homebrew"
  | "npm"
  | "binary"
  | "install-script"
  | "plugin"
  | "app"
  | "web"
  | "source";
/** The rule that decided, in the spec's order. `env` is `<PREFIX>_TELEMETRY`. */
export type Reason =
  | "no-endpoint"
  | "do-not-track"
  | "env"
  | "ci"
  | "test"
  | "dev-version"
  | "state"
  | "default";
export type Env = Record<string, string | undefined>;

export interface TelemetryOptions {
  product: string;
  version: string;
  /** `TELEGRAM_SYNC_CLI` reads `TELEGRAM_SYNC_CLI_TELEMETRY`. Default: the product upper-cased, other characters as `_`. */
  envPrefix?: string;
  /** The product's state directory; telemetry.json lives here. */
  stateDir: string;
  /** Keeps the state somewhere else than telemetry.json, such as a BB plugin's database. */
  storage?: TelemetryStorage;
  channel: Channel;
  /** Set it when the product knows; otherwise agent, interactive or script. */
  mode?: Mode | undefined;
  /** Allowed feature names; anything else is sent as "other". */
  features?: readonly string[];
  /** Shown in the notice. Default: `<product> telemetry off`. */
  offCommand?: string;
  /** Packagers build with '' to turn telemetry off; tests point it elsewhere. */
  endpoint?: string;
  /** Read instead of process.env. */
  env?: Env;
  /** Overrides the terminal checks: stdin or stderr for the mode, stderr for the notice. */
  tty?: boolean;
}

/** The product fields of createTelemetry, for capture. */
export type CaptureOptions = Omit<
  TelemetryOptions,
  "stateDir" | "channel" | "features" | "offCommand"
> & { channel?: Channel };

/** Synchronous on purpose: a write must be saved before an event is sent. */
export interface TelemetryStorage {
  /** The saved JSON, or undefined when there is none. */
  read(): string | undefined;
  /** Saves the JSON; returns false or throws when it could not. */
  write(json: string): boolean;
}

export interface TelemetryStatus {
  enabled: boolean;
  /** Events are printed to stderr instead of sent. */
  debug: boolean;
  reason: Reason;
  id: string | null;
  stateFile: string;
  endpoint: string;
}

export interface Telemetry {
  /** The notice text while it is due (on, not seen yet), else null; for apps and plugins. */
  noticeText(): string | null;
  /** Prints the notice once if due, when stderr is a terminal or an agent runs it. True if printed. */
  showNotice(): boolean;
  /** For apps, plugins and install scripts that showed the notice themselves. */
  markNoticeSeen(): void;
  /** app_started, plus app_installed the first time this install sends. */
  started(): void;
  feature(name: string): void;
  /** A string is sent as the error type alone, with no message. */
  error(err: unknown): void;
  /**
   * Waits up to `ms` for requests already in flight; cancels nothing. On Node,
   * exit with process.exit() after it: a stalled connect keeps the process
   * alive for undici's 10 s connect timeout even after the 3 s abort.
   */
  flush(ms?: number): Promise<void>;
  status(): TelemetryStatus;
  /** `telemetry on|off`. Returns whether the state file was written. */
  setEnabled(on: boolean): boolean;
}

type Props = Record<string, string>;
type Decision = { enabled: boolean; reason: Reason; debug?: boolean };
interface State {
  id: string | null;
  enabled: boolean | null;
  notice: number;
  installed: boolean;
  daily: Props;
}

const norm = (value: string | undefined) => (value ?? "").trim().toLowerCase();
const isSet = (value: string | undefined) => norm(value) !== "";
const cut = (text: string, max: number) => [...text].slice(0, max).join("");
const quoteRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function safe<T>(fn: () => T, fallback: T) {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function envDecision(endpoint: string, env: Env, prefix: string, version: string) {
  const off = (reason: Reason) => ({ enabled: false, reason }) satisfies Decision;
  if (!endpoint) return off("no-endpoint");
  const dnt = norm(env.DO_NOT_TRACK);
  if (dnt !== "" && dnt !== "0" && dnt !== "false") return off("do-not-track");
  const own = norm(env[`${prefix}_TELEMETRY`]);
  if (["0", "off", "false"].includes(own)) return off("env");
  if (own === "debug") return { enabled: true, reason: "env", debug: true } satisfies Decision;
  if (["1", "on", "true"].includes(own)) return { enabled: true, reason: "env" } satisfies Decision;
  const ci = norm(env.CI);
  if ((ci && ci !== "false") || CI_VARS.some((k) => isSet(env[k]))) {
    return off("ci");
  }
  const testRun = [env.VITEST, env.JEST_WORKER_ID].some(isSet);
  if (norm(env.NODE_ENV) === "test" || testRun) return off("test");
  const v = norm(version).replace(/^v/, "");
  if (v === "" || v === "0.0.0" || v.includes("dev")) return off("dev-version");
  return null;
}

function detectAgent(env: Env) {
  const named = norm(env.AI_AGENT).split("_")[0];
  if (named) return cut(named, 40);
  if (isSet(env.CLAUDECODE)) return "claude-code";
  if (isSet(env.CODEX_SANDBOX) || isSet(env.CODEX_THREAD_ID)) return "codex";
  if (isSet(env.CURSOR_AGENT)) return "cursor";
  if (isSet(env.GEMINI_CLI)) return "gemini";
  return undefined;
}

function scrub(text: string, env: Env) {
  const home = (env.HOME || env.USERPROFILE || safe(os.homedir, "")).replace(/[\\/]+$/, "");
  const swaps = new Map<string, string>();
  for (const h of [home, home.replaceAll("\\", "/")]) {
    if (h) swaps.set(h.toLowerCase(), "~");
  }
  for (const name of [env.USER, env.LOGNAME, env.USERNAME, basename(home)]) {
    const n = norm(name);
    if (n.length > 1 && !swaps.has(n)) swaps.set(n, "<user>");
  }
  let out = text;
  if (swaps.size > 0) {
    const longestFirst = [...swaps.keys()].sort((a, b) => b.length - a.length);
    const alternatives = longestFirst.map(quoteRe).join("|");
    const re = new RegExp(`(?<![A-Za-z0-9])(?:${alternatives})(?![A-Za-z0-9])`, "gi");
    out = text.replace(re, (m) => swaps.get(m.toLowerCase()) ?? "<user>");
  }
  return cut(out.trim(), 300);
}

function errorProps(err: unknown, env: Env) {
  if (typeof err === "string") return { error_type: cut(err, 100) || "Error" };
  if (typeof err !== "object" || err === null) return { error_type: "Error" };
  const e = err as { code?: unknown; name?: unknown; message?: unknown };
  const code = ["string", "number"].includes(typeof e.code) ? `${e.code}` : "";
  const name = typeof e.name === "string" && e.name !== "Error" ? e.name : err.constructor?.name;
  const props: Props = { error_type: cut(code || name || "Error", 100) };
  const message = typeof e.message === "string" ? scrub(e.message, env) : "";
  if (message) props.error_message = message;
  return props;
}

let system: Props | undefined;
function systemProps() {
  if (system) return system;
  const p = process.platform;
  const names: Props = { darwin: "macOS", win32: "Windows", linux: "Linux" };
  const read = (file: string, re: RegExp) =>
    re.exec(safe(() => fs.readFileSync(file, "utf8"), ""))?.[1]?.trim();
  const plist = "/System/Library/CoreServices/SystemVersion.plist";
  const version =
    (p === "darwin" && read(plist, /<key>ProductVersion<\/key>\s*<string>([^<]+)</)) ||
    (p === "linux" && read("/etc/os-release", /^VERSION_ID=["']?([^"'\n]*)/m)) ||
    safe(os.release, "");
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  system = {
    $os: names[p] ?? p,
    $os_version: version,
    arch: process.arch,
    runtime: bun ? `bun ${bun.version}` : `node ${process.versions.node}`,
  };
  return system;
}

function readState(storage: TelemetryStorage) {
  const raw: Partial<Record<keyof State, unknown>> =
    safe(() => JSON.parse(storage.read() ?? "{}"), null) ?? {};
  const daily = typeof raw.daily === "object" && raw.daily ? raw.daily : {};
  const state: State = {
    id: typeof raw.id === "string" && UUID.test(raw.id) ? raw.id : null,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
    notice: typeof raw.notice === "number" ? raw.notice : 0,
    installed: raw.installed === true,
    daily: Object.fromEntries(
      Object.entries(daily).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
  };
  return state;
}

function writeFile(file: string, json: string) {
  if (!file) return false;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(tmp, `${json}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    safe(() => fs.rmSync(tmp, { force: true }), undefined);
    return false;
  }
}

function writeState(storage: TelemetryStorage, state: State) {
  const { id, enabled, notice, installed, daily } = state;
  const json = JSON.stringify({ id, enabled, notice, installed, daily });
  return safe(() => storage.write(json), false);
}

function envelope(event: string, distinctId: string, properties: object) {
  return {
    api_key: API_KEY,
    event,
    distinct_id: distinctId,
    timestamp: new Date().toISOString(),
    properties: {
      $process_person_profile: false,
      $lib: LIB,
      $lib_version: LIB_VERSION,
      ...properties,
    },
  };
}

async function deliver(endpoint: string, body: object, ua: string, debug = false) {
  try {
    const json = JSON.stringify(body);
    if (debug) {
      process.stderr.write(`[telemetry] ${json}\n`);
      return;
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": ua },
      body: json,
      signal: AbortSignal.timeout(3000),
    });
    await res.body?.cancel();
  } catch {}
}

function resolve(o: CaptureOptions) {
  const env = o.env ?? process.env;
  const endpoint = o.endpoint ?? ENDPOINT;
  const prefix = o.envPrefix ?? `${o.product}`.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const agent = detectAgent(env);
  const tty = (stream: { isTTY?: boolean }) => o.tty ?? safe(() => !!stream.isTTY, false);
  const mode: Mode =
    o.mode ||
    (agent ? "agent" : tty(process.stdin) || tty(process.stderr) ? "interactive" : "script");
  const optional = ["$os_version", "channel", "agent"];
  const fixed: Decision | null = envDecision(endpoint, env, prefix, `${o.version ?? ""}`);
  return {
    env,
    endpoint,
    mode,
    fixed,
    noticeFits: () => !!agent || tty(process.stderr),
    ua: `${LIB}/${LIB_VERSION} (${o.product}/${o.version})`,
    common: () => {
      const props: Props = {
        product: o.product,
        $app_version: o.version,
        ...systemProps(),
        channel: o.channel ?? "",
        mode,
        agent: agent ?? "",
      };
      return Object.fromEntries(
        Object.entries(props).filter(([k, v]) => v || !optional.includes(k)),
      );
    },
  };
}

/**
 * Sends one event with no state, notice or throttling, for server code with
 * its own ids (random or keyed, never an email or an account id; random when
 * empty). Rules 1-4 of "Turning it off" still apply.
 */
export async function capture(
  event: string,
  properties: Record<string, unknown>,
  distinctId: string,
  options: CaptureOptions,
) {
  try {
    const r = resolve(options);
    if (!event || r.fixed?.enabled === false) return;
    const props = { ...r.common(), ...properties };
    const body = envelope(event, distinctId || randomUUID(), props);
    await deliver(r.endpoint, body, r.ua, r.fixed?.debug);
  } catch {}
}

export function createTelemetry(options: TelemetryOptions) {
  const r = resolve(options);
  const stateDir = options.stateDir;
  const stateFile = stateDir ? join(stateDir, "telemetry.json") : "";
  const storage = options.storage ?? {
    read: () => fs.readFileSync(stateFile, "utf8"),
    write: (json: string) => writeFile(stateFile, json),
  };
  const features = new Set(options.features ?? []);
  const throttled = ["scheduled", "daemon", "plugin", "script"].includes(r.mode);
  const inflight = new Set<Promise<void>>();
  const off = options.offCommand || `${options.product} telemetry off`;
  const notice = `${options.product} shares usage stats with its author: how often it runs, which features are used, errors, version and OS, tied to a random install ID. It never sends your files, arguments or account names. Nothing has been sent yet. Turn it off with \`${off}\` or \`DO_NOT_TRACK=1\`. Details: ${NOTICE_URL}`;
  let quiet = false;

  const decide = (state: State) => {
    const decision: Decision = r.fixed ?? {
      enabled: state.enabled ?? true,
      reason: state.enabled === null ? "default" : "state",
    };
    return decision;
  };
  const due = (state: State) => decide(state).enabled && state.notice < NOTICE_VERSION;

  const seen = (state: State, silence: boolean) => {
    const first = state.notice < NOTICE_VERSION;
    state.notice = NOTICE_VERSION;
    state.id ??= randomUUID();
    if (!writeState(storage, state)) return false;
    if (first && silence) quiet = true;
    return true;
  };

  const track = (event: string, extra: Props, key: string) => {
    if (quiet || r.fixed?.enabled === false) return;
    const state = readState(storage);
    const decision = decide(state);
    if (!decision.enabled || state.notice < NOTICE_VERSION) return;
    const day = new Date().toISOString().slice(0, 10);
    const events: [string, Props][] = [];
    if (!state.installed) events.push(["app_installed", {}]);
    if (!throttled || state.daily[key] !== day) events.push([event, extra]);
    if (events.length === 0) return;
    const changed = !state.id || !state.installed || throttled;
    const id = state.id ?? randomUUID();
    if (throttled) {
      const kept = Object.entries(state.daily).filter(([, d]) => d === day);
      state.daily = { ...Object.fromEntries(kept), [key]: day };
    }
    const next = { ...state, id, installed: true };
    if (changed && !writeState(storage, next)) return;
    const common = r.common();
    for (const [name, props] of events) {
      const body = envelope(name, id, { ...common, ...props });
      const sent = deliver(r.endpoint, body, r.ua, decision.debug);
      inflight.add(sent);
      void sent.then(() => inflight.delete(sent));
    }
  };

  const telemetry: Telemetry = {
    noticeText: () => safe(() => (due(readState(storage)) ? notice : null), null),
    showNotice: () =>
      safe(() => {
        const state = readState(storage);
        if (!due(state) || !r.noticeFits() || !seen(state, true)) return false;
        process.stderr.write(`${notice}\n`);
        return true;
      }, false),
    markNoticeSeen: () =>
      safe(() => {
        const state = readState(storage);
        if (due(state)) seen(state, true);
      }, undefined),
    started: () => safe(() => track("app_started", {}, "app_started"), undefined),
    feature: (name) =>
      safe(() => {
        const feature = features.has(name) ? name : "other";
        track("feature_used", { feature }, `feature_used:${feature}`);
      }, undefined),
    error: (err) =>
      safe(() => {
        const props = errorProps(err, r.env);
        track("error_occurred", props, `error_occurred:${props.error_type}`);
      }, undefined),
    flush: async (ms = 500) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wait = new Promise<void>((done) => {
        timer = setTimeout(done, ms);
      });
      await Promise.race([Promise.all(inflight), wait]);
      clearTimeout(timer);
    },
    status: () => {
      const state = readState(storage);
      const { enabled, reason, debug = false } = decide(state);
      return {
        enabled,
        debug,
        reason,
        id: state.id,
        stateFile,
        endpoint: r.endpoint,
      };
    },
    setEnabled: (on) =>
      safe(() => {
        const state = readState(storage);
        if (on) return seen({ ...state, enabled: true }, false);
        const cleared: State = {
          id: null,
          enabled: false,
          notice: state.notice,
          installed: false,
          daily: {},
        };
        return writeState(storage, cleared);
      }, false),
  };
  return telemetry;
}
