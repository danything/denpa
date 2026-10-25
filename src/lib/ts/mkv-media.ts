/**
 * **Matroska の映像・音声を中身まで読む** (互換モードで、端末に保存した録画を canvas に描く。`raw/mkv.ts`)。
 *
 * 字幕を運ぶための最小の読み (`mkv.ts` の `MkvSplitter`) とは別に置く (EBML の読み方は `mkv.ts` のものを使う)。こちらはトラックごとの形式
 * (CodecPrivate: avcC / av1C / AudioSpecificConfig / OpusHead) と、コマのトラック番号・キーフレームの印、
 * 飛ぶ位置の表 (Cues) まで読む。読むのは denpa のエンコードが書く形式 (ffmpeg の Matroska) に要るものだけ:
 *
 *     Segment > SeekHead > Seek (SeekID・SeekPosition)   Cues の在りか
 *     Segment > Info > TimestampScale・Duration
 *     Segment > Tracks > TrackEntry                       番号・種類・CodecID・CodecPrivate・
 *                                                          DefaultDuration・Name・Language・Video・Audio
 *     Segment > Cluster > Timestamp・SimpleBlock・BlockGroup (Block・ReferenceBlock)
 *     Segment > Cues > CuePoint > CueTime・CueTrackPositions (CueTrack・CueClusterPosition)
 *
 * **飛ぶときは、頭 (最初の Cluster の手前まで) に飛び先の Cluster からを繋いで読ませる** (`mkv-source.ts`)。
 * 読む側は位置を確かめないので、繋いだものを1本のストリームとして読める。
 *
 * DOM も worker も触らない (`mkv-media.test.ts`)
 */

import { concatBytes } from "@danything/arib/bytes";

import { aacCodec, av1Codec, avcCodec, type Fmp4Track } from "./fmp4";
import {
  BLOCK,
  BLOCK_GROUP,
  CLUSTER,
  CODEC_ID,
  DEFAULT_SCALE,
  ebmlHead,
  INFO,
  readBlock,
  SEGMENT,
  SIMPLE_BLOCK,
  TIMESTAMP,
  TIMESTAMP_SCALE,
  TRACK_ENTRY,
  TRACKS,
  uint,
  UNKNOWN,
} from "./mkv";

const EBML = 0x1a45dfa3;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const DURATION = 0x4489;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_PRIVATE = 0x63a2;
const DEFAULT_DURATION = 0x23e383;
const NAME = 0x536e;
const LANGUAGE = 0x22b59c;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const AUDIO = 0xe1;
const SAMPLING_FREQUENCY = 0xb5;
const CHANNELS = 0x9f;
const REFERENCE_BLOCK = 0xfb;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;

function float(body: Uint8Array): number {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length === 4) return view.getFloat32(0);
  if (body.length === 8) return view.getFloat64(0);
  return 0;
}

/** 大きさの分かっている入れ物の中身を、子ごとに回す */
function* children(
  body: Uint8Array,
): Generator<{ id: number; body: Uint8Array }> {
  let at = 0;
  while (at < body.length) {
    const h = ebmlHead(body, at);
    if (h === null || h.size === UNKNOWN || h.body + h.size > body.length)
      return;
    yield { id: h.id, body: body.subarray(h.body, h.body + h.size) };
    at = h.body + h.size;
  }
}

/** 読めたトラック。映像・音声のどちらでもないもの (字幕) は `kind: 'other'` */
export interface MkvTrack {
  number: number;
  kind: "video" | "audio" | "other";
  codecId: string;
  /** WebCodecs の書き方 (`avc1.640028` / `av01.0.08M.08` / `mp4a.40.2` / `opus`)。読めない形式は null */
  codec: string | null;
  /** CodecPrivate (avcC / av1C / AudioSpecificConfig / OpusHead) */
  config: Uint8Array<ArrayBuffer>;
  /** 1コマの長さ (ナノ秒)。書いていなければ null */
  defaultDuration: number | null;
  name: string;
  language: string;
  width: number;
  height: number;
  channels: number;
  sampleRate: number;
}

const text = (bytes: Uint8Array) =>
  new TextDecoder().decode(bytes).replace(/\0+$/, "");

function readTrack(body: Uint8Array): MkvTrack {
  const track: MkvTrack = {
    number: 0,
    kind: "other",
    codecId: "",
    codec: null,
    config: new Uint8Array(0),
    defaultDuration: null,
    name: "",
    language: "",
    width: 0,
    height: 0,
    channels: 0,
    sampleRate: 0,
  };
  for (const child of children(body)) {
    if (child.id === TRACK_NUMBER) track.number = uint(child.body);
    else if (child.id === TRACK_TYPE) {
      const type = uint(child.body);
      track.kind = type === 1 ? "video" : type === 2 ? "audio" : "other";
    } else if (child.id === CODEC_ID) track.codecId = text(child.body);
    else if (child.id === CODEC_PRIVATE) track.config = child.body.slice();
    else if (child.id === DEFAULT_DURATION)
      track.defaultDuration = uint(child.body);
    else if (child.id === NAME) track.name = text(child.body);
    else if (child.id === LANGUAGE) track.language = text(child.body);
    else if (child.id === VIDEO) {
      for (const v of children(child.body)) {
        if (v.id === PIXEL_WIDTH) track.width = uint(v.body);
        else if (v.id === PIXEL_HEIGHT) track.height = uint(v.body);
      }
    } else if (child.id === AUDIO) {
      for (const a of children(child.body)) {
        if (a.id === CHANNELS) track.channels = uint(a.body);
        else if (a.id === SAMPLING_FREQUENCY)
          track.sampleRate = Math.round(float(a.body));
      }
    }
  }
  track.codec = codecOf(track);
  return track;
}

/** CodecID と CodecPrivate から WebCodecs の書き方を起こす (`ts/fmp4.ts` の `readEntry` と同じ決まり) */
function codecOf(track: MkvTrack): string | null {
  const c = track.config;
  if (track.codecId === "V_MPEG4/ISO/AVC" && c.length >= 4) return avcCodec(c);
  if (track.codecId === "V_AV1" && c.length >= 4) return av1Codec(c);
  if (track.codecId === "A_OPUS") return "opus";
  if (track.codecId.startsWith("A_AAC") && c.length >= 2) return aacCodec(c);
  return null;
}

function readTracks(body: Uint8Array): MkvTrack[] {
  const out: MkvTrack[] = [];
  for (const child of children(body))
    if (child.id === TRACK_ENTRY) out.push(readTrack(child.body));
  return out;
}

/**
 * OpusHead (Matroska の CodecPrivate) を dOps (MP4 の形式) に書き換える。`ts/fmp4.ts` の `opusHead` の逆 —
 * デコードする側 (`raw/fmp4.ts`) は dOps を受け取って OpusHead に直すので、形式を揃えて渡す
 */
export function opusDops(opus: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (opus.length < 19) return null;
  const v = new DataView(opus.buffer, opus.byteOffset, opus.byteLength);
  const family = opus[18]!;
  const table = family === 0 ? new Uint8Array(0) : opus.subarray(19);
  const out = new Uint8Array(11 + table.length);
  const o = new DataView(out.buffer);
  out[1] = opus[9]!; // 出すチャンネル数
  o.setUint16(2, v.getUint16(10, true)); // 頭で捨てる標本数
  o.setUint32(4, v.getUint32(12, true)); // 元の標本化周波数
  o.setInt16(8, v.getInt16(16, true)); // 音量の補正
  out[10] = family;
  out.set(table, 11);
  return out;
}

/** デコードする側 (`raw/fmp4.ts`) が受け取る形式にする。コマの時刻は TimestampScale の刻みで渡す。読めない形式なら null */
export function asFmp4Track(track: MkvTrack, scale: number): Fmp4Track | null {
  if (track.codec === null || track.kind === "other") return null;
  const config = track.codec === "opus" ? opusDops(track.config) : track.config;
  if (config === null) return null;
  return {
    id: track.number,
    kind: track.kind,
    timescale: 1e9 / scale,
    codec: track.codec,
    config,
    width: track.width,
    height: track.height,
    channels: track.channels,
    sampleRate: track.sampleRate,
    defaults: { duration: 0, size: 0, flags: 0 },
  };
}

/** 取り出した1コマ。時刻は TimestampScale の刻み */
export interface MkvBlock {
  track: number;
  at: number;
  key: boolean;
  data: Uint8Array;
}

/**
 * **流れてくる Matroska から、トラックの形式とコマを取り出す。** 足りないところで止めて続きを待つ。
 * Tracks は丸ごと届いてから読む。Segment・Cluster・BlockGroup は中に入り、知らないものは
 * 大きさぶん飛ばす (SeekHead・Cues・Tags・Chapters・字幕トラックのコマは読んでも捨てる側が決める)
 */
export class MkvDemuxer {
  private buffer = new Uint8Array(0);
  /** 時刻の刻み (ナノ秒) */
  scale = DEFAULT_SCALE;
  private base = 0;
  /** 読んでいる BlockGroup。終わりの位置 (`buffer` の中) と、ReferenceBlock があったか (= キーフレームではない) */
  private group: {
    block: MkvBlock | null;
    end: number;
    referenced: boolean;
  } | null = null;

  feed(chunk: Uint8Array): { tracks: MkvTrack[] | null; blocks: MkvBlock[] } {
    const buffer = concatBytes([this.buffer, chunk]);
    let tracks: MkvTrack[] | null = null;
    const blocks: MkvBlock[] = [];
    let at = 0;
    for (;;) {
      this.closeGroup(at, blocks);
      const h = ebmlHead(buffer, at);
      if (h === null) break;
      if (h.id === SEGMENT || h.id === CLUSTER || h.size === UNKNOWN) {
        at = h.body;
        continue;
      }
      if (h.id === BLOCK_GROUP) {
        this.group = { block: null, end: h.body + h.size, referenced: false };
        at = h.body;
        continue;
      }
      const end = h.body + h.size;
      if (end > buffer.length) break;
      const body = buffer.subarray(h.body, end);
      if (h.id === INFO) {
        for (const field of children(body)) {
          if (field.id === TIMESTAMP_SCALE)
            this.scale = uint(field.body) || DEFAULT_SCALE;
        }
      } else if (h.id === TRACKS) tracks = readTracks(body);
      else if (h.id === TIMESTAMP) this.base = uint(body);
      else if (h.id === SIMPLE_BLOCK) {
        const block = this.block(body);
        if (block !== null) blocks.push(block);
      } else if (h.id === BLOCK && this.group !== null) {
        this.group.block = this.block(body) ?? this.group.block;
      } else if (h.id === REFERENCE_BLOCK && this.group !== null)
        this.group.referenced = true;
      at = end;
    }
    this.buffer = buffer.slice(at);
    if (this.group !== null) this.group.end -= at;
    return { tracks, blocks };
  }

  /** BlockGroup を読み終えたら、中の Block を出す */
  private closeGroup(at: number, blocks: MkvBlock[]): void {
    const group = this.group;
    if (group === null || at < group.end) return;
    this.group = null;
    if (group.block !== null)
      blocks.push({ ...group.block, key: !group.referenced });
  }

  /** コマ1つ (`mkv.ts` の `readBlock`)。キーフレームの印は SimpleBlock の旗。Block のときは `closeGroup` が決める */
  private block(body: Uint8Array): MkvBlock | null {
    const block = readBlock(body);
    if (block === null) return null;
    const { track, offset, flags, data } = block;
    return { track, at: this.base + offset, key: (flags & 0x80) !== 0, data };
  }
}

/** 飛ぶ位置の表の1つ (時刻は秒、位置は Segment の中身の頭から) */
export interface MkvCue {
  time: number;
  position: number;
}

/** ファイルの頭から読んだもの (`readMkvHead`) */
export interface MkvHead {
  /** Segment の中身の頭 (ファイルの頭から)。Cues・SeekHead の位置はここから数える */
  segment: number;
  /** 最初の Cluster の位置 (ファイルの頭から)。ここまでが「頭」 */
  firstCluster: number;
  scale: number;
  /** 尺 (秒)。書いていなければ null */
  duration: number | null;
  tracks: MkvTrack[];
  /** Cues の位置 (ファイルの頭から)。SeekHead にも無ければ null */
  cues: number | null;
}

/**
 * ファイルの頭 (最初の Cluster まで) を読む。**最初の Cluster が `bytes` の中に無ければ null**
 * (もっと長く読んで渡し直す)
 */
export function readMkvHead(bytes: Uint8Array): MkvHead | null {
  const ebml = ebmlHead(bytes, 0);
  if (ebml === null || ebml.id !== EBML || ebml.size === UNKNOWN) return null;
  const segment = ebmlHead(bytes, ebml.body + ebml.size);
  if (segment === null || segment.id !== SEGMENT) return null;
  const start = segment.body;
  let scale = DEFAULT_SCALE;
  let rawDuration: number | null = null;
  let tracks: MkvTrack[] = [];
  let cues: number | null = null;
  let at = start;
  for (;;) {
    const h = ebmlHead(bytes, at);
    if (h === null) return null;
    if (h.id === CLUSTER) {
      const duration =
        rawDuration === null ? null : (rawDuration * scale) / 1e9;
      return {
        segment: start,
        firstCluster: at,
        scale,
        duration,
        tracks,
        cues,
      };
    }
    if (h.size === UNKNOWN || h.body + h.size > bytes.length) return null;
    const body = bytes.subarray(h.body, h.body + h.size);
    if (h.id === SEEK_HEAD) {
      for (const seek of children(body)) {
        if (seek.id !== SEEK) continue;
        let id = 0;
        let position = -1;
        for (const field of children(seek.body)) {
          if (field.id === SEEK_ID) id = uint(field.body);
          else if (field.id === SEEK_POSITION) position = uint(field.body);
        }
        if (id === CUES && position >= 0) cues = start + position;
      }
    } else if (h.id === INFO) {
      for (const field of children(body)) {
        if (field.id === TIMESTAMP_SCALE)
          scale = uint(field.body) || DEFAULT_SCALE;
        else if (field.id === DURATION) rawDuration = float(field.body);
      }
    } else if (h.id === TRACKS) tracks = readTracks(body);
    else if (h.id === CUES) cues = at;
    at = h.body + h.size;
  }
}

/** 要素の大きさ (頭も含めて)。頭が読めなければ null */
export function elementSize(bytes: Uint8Array): number | null {
  const h = ebmlHead(bytes, 0);
  return h === null || h.size === UNKNOWN ? null : h.body + h.size;
}

/** Cues を読む。`track` (映像トラック) の位置だけ、時刻の順に */
export function readCues(
  bytes: Uint8Array,
  scale: number,
  track: number,
): MkvCue[] {
  const h = ebmlHead(bytes, 0);
  if (h === null || h.id !== CUES || h.size === UNKNOWN) return [];
  const out: MkvCue[] = [];
  for (const point of children(bytes.subarray(h.body, h.body + h.size))) {
    if (point.id !== CUE_POINT) continue;
    let time = -1;
    for (const field of children(point.body)) {
      if (field.id === CUE_TIME) time = uint(field.body);
      else if (field.id === CUE_TRACK_POSITIONS && time >= 0) {
        let which = 0;
        let position = -1;
        for (const p of children(field.body)) {
          if (p.id === CUE_TRACK) which = uint(p.body);
          else if (p.id === CUE_CLUSTER_POSITION) position = uint(p.body);
        }
        if (which === track && position >= 0)
          out.push({ time: (time * scale) / 1e9, position });
      }
    }
  }
  return out.sort((a, b) => a.time - b.time);
}

/** `seconds` から観るときに読み始める Cluster。表に無ければ null (頭から) */
export function cueBefore(
  cues: readonly MkvCue[],
  seconds: number,
): MkvCue | null {
  let found: MkvCue | null = null;
  for (const cue of cues) {
    if (cue.time > seconds) break;
    found = cue;
  }
  return found;
}
