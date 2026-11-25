export interface FakeMp4 {
  /** Seconds */
  duration: number;
  width: number;
  height: number;
  /** Stored turned by 90°, as a phone held upright records */
  sideways?: boolean;
  /** The data before the index, as a recorder that never rewrote the file leaves it */
  dataFirst?: boolean;
  /** 64-bit times, as files longer than a 32-bit duration use */
  long?: boolean;
  /** The track's handler: `vide` unless the file has no picture */
  handler?: string;
}

const TIMESCALE = 1000;

function box(type: string, ...parts: Uint8Array[]) {
  const size = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, size);
  bytes.set(new TextEncoder().encode(type), 4);
  let at = 8;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

function times(long: boolean, ticks: number, between: number) {
  const bytes = new Uint8Array(long ? 24 + between : 12 + between);
  const view = new DataView(bytes.buffer);
  if (long) view.setBigUint64(16 + between, BigInt(ticks));
  else view.setUint32(8 + between, ticks);
  return bytes;
}

function movieHeader(video: FakeMp4, ticks: number) {
  const long = video.long ?? false;
  const head = times(long, ticks, 4);
  const view = new DataView(head.buffer);
  view.setUint32(long ? 16 : 8, TIMESCALE);
  return box("mvhd", Uint8Array.of(long ? 1 : 0, 0, 0, 0), head, new Uint8Array(80));
}

function trackHeader(video: FakeMp4, ticks: number) {
  const long = video.long ?? false;
  const rest = new Uint8Array(60);
  const view = new DataView(rest.buffer);
  const [a, b, c, d] = video.sideways ? [0, 1, -1, 0] : [1, 0, 0, 1];
  view.setInt32(16, a * 65536);
  view.setInt32(20, b * 65536);
  view.setInt32(28, c * 65536);
  view.setInt32(32, d * 65536);
  view.setInt32(48, 0x40000000);
  view.setUint32(52, video.width * 65536);
  view.setUint32(56, video.height * 65536);
  return box("tkhd", Uint8Array.of(long ? 1 : 0, 0, 0, 3), times(long, ticks, 8), rest);
}

function handler(type: string) {
  const bytes = new Uint8Array(24);
  bytes.set(new TextEncoder().encode(type), 8);
  return box("hdlr", bytes);
}

/** The bytes of a made-up MP4: its boxes are real, its picture data is not */
export function fakeMp4(video: FakeMp4) {
  const ticks = Math.round(video.duration * TIMESCALE);
  const type = box("ftyp", new TextEncoder().encode("isom\0\0\0\0isommp42"));
  const index = box(
    "moov",
    movieHeader(video, ticks),
    box("trak", trackHeader(video, ticks), box("mdia", handler(video.handler ?? "vide"))),
  );
  const data = box("mdat", new Uint8Array(64).fill(7));
  const parts = video.dataFirst ? [type, data, index] : [type, index, data];
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}
