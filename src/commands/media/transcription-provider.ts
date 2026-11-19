import type { TranscriptSource } from "../../types";
import type { MediaError } from "./errors";

/** The file as Telegram stores it (OGG/Opus, MP4), or 16 kHz mono WAV */
export type AudioFormat = "original" | "wav16k";

/** What a provider reads */
export type ProviderInput =
  | { kind: "message" }
  | { kind: "audio"; formats: readonly AudioFormat[] };

/** Known before anything runs, so the caller can decide and explain */
export interface ProviderDeclaration {
  /** The registry key, stored as the transcript's `source` */
  id: TranscriptSource;
  /** The program or service that does the work; stored as `runner` */
  engine: string;
  /** The model it uses, as stored and printed; null when it doesn't say */
  model: string | null;
  /** Where the audio (or the message reference) goes: null keeps it on this machine */
  sendsTo: string | null;
  /** Whether a request can cost money */
  cost: "free" | "paid";
  input: ProviderInput;
  /** Requests per call; 1 for a provider that takes one at a time */
  batchSize: number;
  /** Calls in flight at once */
  concurrency: number;
  /** Longer audio is refused before it is fetched; null for no limit */
  maxDurationSeconds: number | null;
}

/** One message to transcribe, already checked as eligible */
export interface TranscriptionRequest {
  chatId: number;
  messageId: number;
  kind: "voice" | "round";
  durationSeconds: number | null;
  /** The file this transcript is for: a stored transcript is valid for it only */
  uniqueFileId: string;
  /** The audio in a declared format; null when the provider reads the message */
  audio: { path: string; format: AudioFormat; mimeType: string | null } | null;
}

/**
 * Why a request failed: `rejected` won't work again as it is; `retry_later`
 * may (a rate limit, a result still pending); `outcome_unknown` may have
 * been accepted and billed, so it must not be retried blindly
 */
export type ProviderFailure = "rejected" | "retry_later" | "outcome_unknown";

export type ProviderResult =
  | {
      status: "done";
      text: string;
      language: string | null;
      /** The model that made it, when it differs per request */
      model: string | null;
    }
  | { status: "failed"; failure: ProviderFailure; error: MediaError };

export interface TranscriptionOptions {
  /** The speech's language code; null lets the provider detect it */
  language: string | null;
  /** Aborted on SIGINT/SIGTERM: stop work and reject */
  signal: AbortSignal;
}

export interface TranscriptionProvider {
  readonly declaration: ProviderDeclaration;
  /** One result per request, in order; at most `batchSize` requests */
  transcribe(
    requests: readonly TranscriptionRequest[],
    options: TranscriptionOptions,
  ): Promise<ProviderResult[]>;
}

/**
 * A provider ready to run, or the setup problem (with the command or
 * setting that fixes it) that stops it. Readiness covers everything the
 * declared input needs: ffmpeg when the provider takes no original audio.
 */
export type ProviderSetup =
  | {
      ready: true;
      provider: TranscriptionProvider;
      /** The converter for formats other than `original`; null when none is needed */
      ffmpeg: string | null;
    }
  | { ready: false; problem: MediaError };
