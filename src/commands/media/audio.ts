import { ErrorCodes } from "../../types";
import { runLocalProcess } from "./local-process";
import { MediaError } from "./errors";

/** Below this peak the audio is digital silence, which Whisper fills with invented phrases */
export const SILENCE_MAX_VOLUME_DB = -60;

/** The last lines of a program's stderr, for an error's details */
export function tail(text: string, lines = 20) {
  return text.trimEnd().split("\n").slice(-lines).join("\n").slice(-2000);
}

/**
 * Convert to 16 kHz mono WAV and return the peak level in dB (-Infinity for
 * all-zero audio). Telegram's voice notes are OGG/Opus and video notes MP4,
 * which whisper.cpp can't read. Aborting `signal` kills ffmpeg.
 */
export async function convertToWav(
  ffmpeg: string,
  input: string,
  wav: string,
  signal: AbortSignal,
) {
  let peakDb: number | undefined;
  let carry = "";
  const { stderr, exitCode } = await runLocalProcess(
    [
      ffmpeg,
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-y",
      "-i",
      input,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      "volumedetect",
      wav,
    ],
    signal,
    (chunk) => {
      const text = carry + chunk;
      const match = text.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/);
      if (match) peakDb = match[1] === "-inf" ? -Infinity : Number(match[1]);
      carry = text.slice(-64);
    },
  );
  if (exitCode !== 0 || peakDb === undefined) {
    throw new MediaError(ErrorCodes.GENERAL_ERROR, "ffmpeg could not convert the audio", {
      program: ffmpeg,
      exitCode,
      stderr: tail(stderr),
    });
  }
  return peakDb;
}
