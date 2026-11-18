import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TelegramClient } from "@mtcute/bun";

type Primitive = string | number | boolean | null;
type DehydratedValue =
  | Primitive
  | DehydratedValue[]
  | { [key: string]: DehydratedValue }
  | {
      __tgcli_type: "bigint" | "bytes" | "date";
      value: string;
    };

export type RecordReplayMode = "off" | "record" | "replay";

export interface RecordReplayConfig {
  mode: RecordReplayMode;
  fixturesDir: string;
}

interface FixtureRecord {
  schemaVersion: 1;
  recordedAt: string;
  method: string;
  request: DehydratedValue;
  response: DehydratedValue;
}

const TYPE_KEY = "__tgcli_type";

function parseBooleanEnv(value?: string): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? process.env.TELEGRAM_SYNC_CLI_DATA_DIR ?? join(homedir(), ".telegram-sync-cli");
}

export function getRecordReplayConfig(dataDir?: string): RecordReplayConfig {
  const replay = parseBooleanEnv(process.env.TELEGRAM_API_REPLAY);
  const record = parseBooleanEnv(process.env.TELEGRAM_API_RECORD);
  const mode: RecordReplayMode = replay ? "replay" : record ? "record" : "off";
  const fixturesDir =
    process.env.TELEGRAM_API_FIXTURES_DIR ?? join(resolveDataDir(dataDir), "fixtures", "telegram");
  return { mode, fixturesDir };
}

function isMarkerObject(value: unknown): value is { __tgcli_type: string; value: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    TYPE_KEY in value &&
    typeof (value as { __tgcli_type?: unknown }).__tgcli_type === "string"
  );
}

export function dehydrate(value: unknown): DehydratedValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return { __tgcli_type: "bigint", value: value.toString() };
  }

  if (value instanceof Date) {
    return { __tgcli_type: "date", value: value.toISOString() };
  }

  if (value instanceof Uint8Array) {
    return {
      __tgcli_type: "bytes",
      value: Buffer.from(value).toString("base64"),
    };
  }

  if (value instanceof ArrayBuffer) {
    return {
      __tgcli_type: "bytes",
      value: Buffer.from(new Uint8Array(value)).toString("base64"),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : dehydrate(item)));
  }

  if (typeof value === "object") {
    const result: Record<string, DehydratedValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      result[key] = dehydrate(entry);
    }
    return result;
  }

  return String(value);
}

export function rehydrate(value: DehydratedValue): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => rehydrate(entry as DehydratedValue));
  }

  if (isMarkerObject(value)) {
    if (value.__tgcli_type === "bigint") {
      return BigInt(value.value);
    }
    if (value.__tgcli_type === "bytes") {
      return Uint8Array.from(Buffer.from(value.value, "base64"));
    }
    if (value.__tgcli_type === "date") {
      return new Date(value.value);
    }
  }

  const hydrated: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    hydrated[key] = rehydrate(entry as DehydratedValue);
  }
  return hydrated;
}

function sortForStable(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortForStable(entry));
  }
  if (value && typeof value === "object" && !isMarkerObject(value)) {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    const sorted: Record<string, unknown> = {};
    for (const [key, entry] of entries) {
      sorted[key] = sortForStable(entry);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStable(value));
}

function sanitizeMethod(method: string): string {
  return method.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function buildFixturePaths(options: {
  fixturesDir: string;
  accountId?: number;
  method: string;
  request: unknown;
  callOptions?: unknown;
}): { dir: string; path: string } {
  const accountSegment =
    typeof options.accountId === "number" ? `account-${options.accountId}` : "account-unknown";
  const methodSegment = sanitizeMethod(options.method);
  const dir = join(options.fixturesDir, accountSegment, methodSegment);
  const hash = createHash("sha256")
    .update(
      stableStringify(
        dehydrate({
          request: options.request,
          callOptions: options.callOptions ?? null,
        }),
      ),
    )
    .digest("hex");
  return { dir, path: join(dir, `${hash}.json`) };
}

async function readFixture(path: string): Promise<FixtureRecord> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Replay fixture not found: ${path}`);
  }
  const raw = await file.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Replay fixture is invalid JSON: ${path} (${(err as Error).message})`);
  }
  const record = parsed as FixtureRecord;
  if (record.schemaVersion !== 1) {
    throw new Error(`Replay fixture schema mismatch: ${path} (expected 1)`);
  }
  return record;
}

async function writeFixture(path: string, record: FixtureRecord): Promise<void> {
  await Bun.write(path, JSON.stringify(record, null, 2));
}

export function wrapClientCallWithRecordReplay(
  client: TelegramClient,
  options: {
    accountId?: number;
    dataDir?: string;
    config?: RecordReplayConfig;
  } = {},
): TelegramClient {
  const config = options.config ?? getRecordReplayConfig(options.dataDir);
  if (config.mode === "off") return client;

  const clientAny = client as TelegramClient & {
    __recordReplayWrapped?: boolean;
    __recordReplayConfig?: RecordReplayConfig;
    __recordReplayAccountId?: number;
    __recordReplayOriginalCall?: TelegramClient["call"];
  };

  if (clientAny.__recordReplayWrapped) {
    clientAny.__recordReplayConfig = config;
    if (options.accountId !== undefined) {
      clientAny.__recordReplayAccountId = options.accountId;
    }
    return client;
  }

  clientAny.__recordReplayWrapped = true;
  clientAny.__recordReplayConfig = config;
  clientAny.__recordReplayAccountId = options.accountId;

  const originalCall = client.call.bind(client);
  clientAny.__recordReplayOriginalCall = originalCall;

  clientAny.call = (async (request, callOptions) => {
    const activeConfig = clientAny.__recordReplayConfig ?? config;
    if (activeConfig.mode === "off") {
      return originalCall(request, callOptions);
    }

    const method = request._ ?? "unknown";
    const { dir, path } = buildFixturePaths({
      fixturesDir: activeConfig.fixturesDir,
      accountId: clientAny.__recordReplayAccountId,
      method,
      request,
      callOptions,
    });

    if (activeConfig.mode === "replay") {
      const record = await readFixture(path);
      return rehydrate(record.response);
    }

    mkdirSync(dir, { recursive: true });
    const response = await originalCall(request, callOptions);
    const record: FixtureRecord = {
      schemaVersion: 1,
      recordedAt: new Date().toISOString(),
      method,
      request: dehydrate({
        request,
        callOptions: callOptions ?? null,
      }),
      response: dehydrate(response),
    };
    await writeFixture(path, record);
    return response;
  }) as TelegramClient["call"];

  return client;
}
