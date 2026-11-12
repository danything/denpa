/**
 * fragmented MP4 (ISO/IEC 14496-12) を書く。初期化セグメント (`ftyp` + `moov`) と、メディアセグメント (`moof` + `mdat`)。
 *
 * 4K の放送の HEVC と AAC を、ffmpeg を通さずに MSE や ffmpeg へ渡す形にするところ (`mmt.ts`) で使う。
 * ffmpeg が出す fMP4 を割る・読むのは `ts/fmp4.ts` で、こちらはその書く側。書くのは読む側が要るもの
 * (`default-base-is-moof`・tfdt・trun) だけで、時刻の刻みはどのトラックも 90 kHz (放送の時刻と同じ)
 */

import { concatBytes } from "@danything/arib/bytes";

export const TIMESCALE = 90_000;

/** 映像のトラック (HEVC) */
export interface VideoTrack {
  kind: "video";
  id: number;
  width: number;
  height: number;
  /** `hvcC` の中身 (`hevc.ts`) */
  hvcC: Uint8Array;
}

/** 音声のトラック (AAC) */
export interface AudioTrack {
  kind: "audio";
  id: number;
  sampleRate: number;
  channels: number;
  audioSpecificConfig: Uint8Array;
}

type Mp4Track = VideoTrack | AudioTrack;

/** 1 コマ (1 フレーム)。時間は 90 kHz */
export interface Mp4Sample {
  data: Uint8Array;
  duration: number;
  /** PTS - DTS (B ピクチャの並べ替えのずれ) */
  offset: number;
  keyframe: boolean;
}

const be16 = (value: number) => [(value >> 8) & 0xff, value & 0xff];
const be32 = (value: number) => [
  (value >>> 24) & 0xff,
  (value >> 16) & 0xff,
  (value >> 8) & 0xff,
  value & 0xff,
];
/** 64 ビット (2^53 まで) */
const be64 = (value: number) => [
  ...be32(Math.floor(value / 2 ** 32)),
  ...be32(value % 2 ** 32),
];
const fourcc = (type: string) => [...type].map((c) => c.charCodeAt(0));

type Part = Uint8Array | number[];

function box(type: string, ...parts: Part[]): Uint8Array {
  const body = concatBytes(parts.map((p) => Uint8Array.from(p)));
  return concatBytes([
    Uint8Array.from([...be32(8 + body.length), ...fourcc(type)]),
    body,
  ]);
}

function fullBox(
  type: string,
  version: number,
  flags: number,
  ...parts: Part[]
): Uint8Array {
  return box(
    type,
    [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff],
    ...parts,
  );
}

/** 変換しない行列 (mvhd・tkhd) */
const MATRIX = [
  ...be32(0x00010000),
  ...be32(0),
  ...be32(0),
  ...be32(0),
  ...be32(0x00010000),
  ...be32(0),
  ...be32(0),
  ...be32(0),
  ...be32(0x40000000),
];

/** MPEG-4 の記述子 (esds の中)。長さはいつも 4 バイトで書く */
function descriptor(tag: number, ...parts: Part[]): number[] {
  const body = parts.flatMap((p) => [...p]);
  const n = body.length;
  return [
    tag,
    0x80 | ((n >> 21) & 0x7f),
    0x80 | ((n >> 14) & 0x7f),
    0x80 | ((n >> 7) & 0x7f),
    n & 0x7f,
    ...body,
  ];
}

function sampleEntry(track: Mp4Track): Uint8Array {
  const head = [0, 0, 0, 0, 0, 0, ...be16(1)]; // 予約・data_reference_index
  if (track.kind === "video")
    return box(
      "hvc1",
      head,
      new Array(16).fill(0), // pre_defined・予約
      be16(track.width),
      be16(track.height),
      be32(0x00480000), // 72 dpi
      be32(0x00480000),
      be32(0),
      be16(1), // frame_count
      new Array(32).fill(0), // compressorname
      be16(0x0018),
      be16(0xffff),
      box("hvcC", track.hvcC),
    );
  const esds = fullBox(
    "esds",
    0,
    0,
    descriptor(
      0x03, // ES_Descriptor
      be16(track.id),
      [0x00],
      descriptor(
        0x04, // DecoderConfigDescriptor
        [0x40, 0x15], // MPEG-4 Audio、音声のストリーム
        [0, 0, 0], // bufferSizeDB
        be32(0), // maxBitrate
        be32(0), // avgBitrate
        descriptor(0x05, track.audioSpecificConfig),
      ),
      descriptor(0x06, [0x02]), // SLConfigDescriptor
    ),
  );
  return box(
    "mp4a",
    head,
    new Array(8).fill(0),
    be16(track.channels),
    be16(16),
    be32(0),
    be32((track.sampleRate & 0xffff) * 0x10000),
    esds,
  );
}

function trak(track: Mp4Track): Uint8Array {
  const video = track.kind === "video";
  const tkhd = fullBox(
    "tkhd",
    0,
    0x000003, // 有効・動画で使う
    be32(0),
    be32(0),
    be32(track.id),
    be32(0),
    be32(0), // duration (fragmented なので 0)
    new Array(8).fill(0),
    be16(0), // layer
    be16(0), // alternate_group
    be16(video ? 0 : 0x0100), // volume
    be16(0),
    MATRIX,
    be32(video ? track.width * 0x10000 : 0),
    be32(video ? track.height * 0x10000 : 0),
  );
  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    be32(0),
    be32(0),
    be32(TIMESCALE),
    be32(0),
    be16(0x55c4), // und
    be16(0),
  );
  const handler = video ? "vide" : "soun";
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    be32(0),
    fourcc(handler),
    new Array(12).fill(0),
    [...fourcc(video ? "VideoHandler" : "SoundHandler"), 0],
  );
  const header = video
    ? fullBox("vmhd", 0, 1, new Array(8).fill(0))
    : fullBox("smhd", 0, 0, new Array(4).fill(0));
  const dinf = box(
    "dinf",
    fullBox("dref", 0, 0, be32(1), fullBox("url ", 0, 1)),
  );
  const stbl = box(
    "stbl",
    fullBox("stsd", 0, 0, be32(1), sampleEntry(track)),
    fullBox("stts", 0, 0, be32(0)),
    fullBox("stsc", 0, 0, be32(0)),
    fullBox("stsz", 0, 0, be32(0), be32(0)),
    fullBox("stco", 0, 0, be32(0)),
  );
  return box(
    "trak",
    tkhd,
    box("mdia", mdhd, hdlr, box("minf", header, dinf, stbl)),
  );
}

/** 初期化セグメント (`ftyp` + `moov`) */
export function initSegment(tracks: readonly Mp4Track[]): Uint8Array {
  const ftyp = box(
    "ftyp",
    fourcc("isom"),
    be32(0x200),
    fourcc("isom"),
    fourcc("iso6"),
    fourcc("mp41"),
  );
  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    be32(0),
    be32(0),
    be32(TIMESCALE),
    be32(0),
    be32(0x00010000), // rate
    be16(0x0100), // volume
    new Array(10).fill(0),
    MATRIX,
    new Array(24).fill(0),
    be32(Math.max(...tracks.map((t) => t.id)) + 1),
  );
  const mvex = box(
    "mvex",
    ...tracks.map((t) =>
      fullBox("trex", 0, 0, be32(t.id), be32(1), be32(0), be32(0), be32(0)),
    ),
  );
  return concatBytes([ftyp, box("moov", mvhd, ...tracks.map(trak), mvex)]);
}

/** sample_flags。頭出しできるコマは「ほかのコマを参照しない」、それ以外は「ほかのコマを参照する・sync でない」 */
const KEY_FLAGS = 0x02000000;
const DEPENDENT_FLAGS = 0x01010000;

/** trun の印: data-offset・duration・size・flags・composition time offset */
const TRUN_FLAGS = 0x000001 | 0x000100 | 0x000200 | 0x000400 | 0x000800;

function moof(
  sequence: number,
  trackId: number,
  decodeTime: number,
  samples: readonly Mp4Sample[],
  dataOffset: number,
): Uint8Array {
  const trun = fullBox(
    "trun",
    1, // composition time offset を符号つきで書く
    TRUN_FLAGS,
    be32(samples.length),
    be32(dataOffset),
    samples.flatMap((s) => [
      ...be32(s.duration),
      ...be32(s.data.length),
      ...be32(s.keyframe ? KEY_FLAGS : DEPENDENT_FLAGS),
      ...be32(s.offset),
    ]),
  );
  return box(
    "moof",
    fullBox("mfhd", 0, 0, be32(sequence)),
    box(
      "traf",
      fullBox("tfhd", 0, 0x020000, be32(trackId)), // default-base-is-moof
      fullBox("tfdt", 1, 0, be64(decodeTime)),
      trun,
    ),
  );
}

/**
 * メディアセグメント (`moof` + `mdat`) を 1 トラックぶん。`decodeTime` は最初のコマの DTS (90 kHz、0 以上)。
 * `sequence` は 1 から数えて、セグメントごとに 1 つ増やす
 */
export function mediaSegment(
  sequence: number,
  trackId: number,
  decodeTime: number,
  samples: readonly Mp4Sample[],
): Uint8Array {
  // moof の大きさは中身の位置に依らないので、仮に組んで測る
  const size = moof(sequence, trackId, decodeTime, samples, 0).length;
  const data = concatBytes(samples.map((s) => s.data));
  return concatBytes([
    moof(sequence, trackId, decodeTime, samples, size + 8),
    Uint8Array.from([...be32(8 + data.length), ...fourcc("mdat")]),
    data,
  ]);
}
