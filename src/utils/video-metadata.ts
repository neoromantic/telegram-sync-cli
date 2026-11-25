/** What Telegram needs to show an MP4 or MOV file as a video */
export interface VideoMetadata {
  /** Seconds */
  duration: number;
  width: number;
  height: number;
  /** The index (`moov`) comes before the data, so playback can start during the download */
  streamable: boolean;
}

const MOOV_MAX_BYTES = 64 * 1024 * 1024;

interface Box {
  type: string;
  start: number;
  end: number;
}

function boxAt(view: DataView, at: number, remaining: number) {
  if (at + 8 > view.byteLength) return null;
  const size32 = view.getUint32(at);
  const large = size32 === 1;
  if (large && at + 16 > view.byteLength) return null;
  const header = large ? 16 : 8;
  const size = large ? Number(view.getBigUint64(at + 8)) : size32 === 0 ? remaining : size32;
  if (size < header || size > remaining) return null;
  const type = String.fromCharCode(
    view.getUint8(at + 4),
    view.getUint8(at + 5),
    view.getUint8(at + 6),
    view.getUint8(at + 7),
  );
  return { type, header, size };
}

function children(view: DataView, start: number, end: number) {
  const found: Box[] = [];
  let at = start;
  while (at < end) {
    const box = boxAt(view, at, end - at);
    if (!box) break;
    found.push({ type: box.type, start: at + box.header, end: at + box.size });
    at += box.size;
  }
  return found;
}

function child(view: DataView, parent: Box, type: string) {
  return children(view, parent.start, parent.end).find((box) => box.type === type);
}

async function readMoov(path: string) {
  const file = Bun.file(path);
  let at = 0;
  let dataFirst = false;
  while (at < file.size) {
    const head = new DataView(await file.slice(at, at + 16).arrayBuffer());
    const box = boxAt(head, 0, file.size - at);
    if (!box) return null;
    if (box.type === "moov") {
      if (box.size > MOOV_MAX_BYTES) return null;
      const bytes = await file.slice(at + box.header, at + box.size).arrayBuffer();
      return { view: new DataView(bytes), streamable: !dataFirst };
    }
    if (box.type === "mdat") dataFirst = true;
    at += box.size;
  }
  return null;
}

function movieSeconds(view: DataView, moov: Box) {
  const mvhd = child(view, moov, "mvhd");
  if (!mvhd) return null;
  const long = view.getUint8(mvhd.start) === 1;
  const timescale = view.getUint32(mvhd.start + (long ? 20 : 12));
  if (timescale === 0) return null;
  const duration = long
    ? Number(view.getBigUint64(mvhd.start + 24))
    : view.getUint32(mvhd.start + 16);
  return duration / timescale;
}

function videoTrackSize(view: DataView, moov: Box) {
  for (const trak of children(view, moov.start, moov.end)) {
    if (trak.type !== "trak") continue;
    const mdia = child(view, trak, "mdia");
    const hdlr = mdia && child(view, mdia, "hdlr");
    const tkhd = child(view, trak, "tkhd");
    if (!hdlr || !tkhd) continue;
    if (view.getUint32(hdlr.start + 8) !== 0x76696465) continue;

    const matrix = tkhd.start + (view.getUint8(tkhd.start) === 1 ? 52 : 40);
    const width = Math.round(view.getUint32(matrix + 36) / 65536);
    const height = Math.round(view.getUint32(matrix + 40) / 65536);
    if (width === 0 || height === 0) continue;
    const sideways = view.getInt32(matrix) === 0 && view.getInt32(matrix + 4) !== 0;
    return sideways ? { width: height, height: width } : { width, height };
  }
  return null;
}

/**
 * Duration and frame size of an MP4 or MOV file, read from its `moov` box.
 * `null` for any other file, one without a video track, and one cut short.
 */
export async function readVideoMetadata(path: string) {
  const none: VideoMetadata | null = null;
  const moov = await readMoov(path);
  if (!moov) return none;
  const { view } = moov;
  const root: Box = { type: "moov", start: 0, end: view.byteLength };
  try {
    const duration = movieSeconds(view, root);
    const size = videoTrackSize(view, root);
    if (duration === null || !size) return none;
    const metadata: VideoMetadata = { duration, ...size, streamable: moov.streamable };
    return metadata;
  } catch (err) {
    if (err instanceof RangeError) return none;
    throw err;
  }
}
