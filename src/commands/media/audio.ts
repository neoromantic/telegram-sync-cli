/**
 * Audio preparation for transcription: ffmpeg converts a voice or video
 * note to 16 kHz mono WAV and measures its peak in the same pass.
 */
import { ErrorCodes } from '../../types'
import { MediaError } from './errors'

/** Below this peak the audio is digital silence, which Whisper fills with invented phrases */
export const SILENCE_MAX_VOLUME_DB = -60

/** The last lines of a program's stderr, for an error's details */
export function tail(text: string, lines = 20): string {
  return text.trimEnd().split('\n').slice(-lines).join('\n').slice(-2000)
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
): Promise<number> {
  const proc = Bun.spawn(
    [
      ffmpeg,
      '-nostdin',
      '-hide_banner',
      '-nostats',
      '-y',
      '-i',
      input,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-af',
      'volumedetect',
      wav,
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', signal },
  )
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  signal.throwIfAborted()
  const peak = stderr.match(/max_volume:\s*(-?[\d.]+|-inf)\s*dB/)
  if (exitCode !== 0 || !peak) {
    throw new MediaError(
      ErrorCodes.GENERAL_ERROR,
      'ffmpeg could not convert the audio',
      { program: ffmpeg, exitCode, stderr: tail(stderr) },
    )
  }
  return peak[1] === '-inf' ? -Infinity : Number(peak[1])
}
