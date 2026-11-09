/**
 * **Matroska を読む。** 字幕を運ぶストリーム (ライブと録画の字幕。`mkv.ts` の `MkvSplitter`) と、
 * 互換モードで canvas に描く端末に保存した録画 (`raw/mkv.ts`・`mkv-source.ts`) の両方がこれを使う。
 * 読むのは denpa の ffmpeg が書く形式に要るものだけ。
 *
 *     Segment > SeekHead > Seek (SeekID・SeekPosition)   Cues の位置
 *     Segment > Info > TimestampScale・Duration
 *     Segment > Tracks > TrackEntry                       番号・種類・CodecID・CodecPrivate・
 *                                                          DefaultDuration・Name・Language・Video
 *     Segment > Cluster > Timestamp・SimpleBlock・BlockGroup (Block・ReferenceBlock)
 *     Segment > Cues > CuePoint > CueTime・CueTrackPositions (CueTrack・CueClusterPosition)
 *
 * EBML は `[ID][大きさ][中身]` の入れ子。**中に入るものと飛ばすものを決めておけば、ほかの要素は
 * 大きさぶん飛ばせる**ので、全部を読めなくてよい。
 *
 * **飛ぶときは、先頭 (最初の Cluster の手前まで) に飛び先の Cluster からを繋いで読ませる** (`mkv-source.ts`)。
 * 読む側は位置を確かめないので、繋いだものを 1 本のストリームとして読める。
 *
 * DOM も worker も触らない (`mkv-media.test.ts`)
 */

import { concatBytes, u16 } from "@danything/arib/bytes";

import { aacCodec, av1Codec, avcCodec, type Fmp4Track } from "./fmp4";

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const SEEK_HEAD = 0x114d9b74;
const SEEK = 0x4dbb;
const SEEK_ID = 0x53ab;
const SEEK_POSITION = 0x53ac;
const INFO = 0x1549a966;
const TIMESTAMP_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
const CODEC_ID = 0x86;
const CODEC_PRIVATE = 0x63a2;
const DEFAULT_DURATION = 0x23e383;
const NAME = 0x536e;
const LANGUAGE = 0x22b59c;
const VIDEO = 0xe0;
const PIXEL_WIDTH = 0xb0;
const PIXEL_HEIGHT = 0xba;
const CLUSTER = 0x1f43b675;
const TIMESTAMP = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const REFERENCE_BLOCK = 0xfb;
const CUES = 0x1c53bb6b;
const CUE_POINT = 0xbb;
const CUE_TIME = 0xb3;
const CUE_TRACK_POSITIONS = 0xb7;
const CUE_TRACK = 0xf7;
const CUE_CLUSTER_POSITION = 0xf1;

/** 大きさが「不明」の印 (全部 1)。ヘッダだけ書いて流し始めるときに出てくる */
const UNKNOWN = -1;

/** 時刻の刻みの既定 (ナノ秒)。1ms */
const DEFAULT_SCALE = 1_000_000;

/** 読めた要素のヘッダ。`body` は中身の先頭位置 */
interface EbmlHead {
  id: number;
  size: number;
  body: number;
}

/**
 * EBML の可変長整数。
 *
 * 先頭バイトの**最初に立っているビットの位置**が長さ (1〜8 バイト)。
 * ID はその印も含めた並びをそのまま値とし (慣例)、大きさは印を落とした値を採る。
 *
 * @returns 読めなければ null (まだ足りない)
 */
function vint(
  buffer: Uint8Array,
  at: number,
  keepMarker: boolean,
): { value: number; next: number } | null {
  if (at >= buffer.length) return null;
  const first = buffer[at]!;
  if (first === 0) return null;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length++;
  if (length > 8 || at + length > buffer.length) return null;

  const mask = length >= 8 ? 0 : 0xff >> length;
  let value = keepMarker ? first : first & mask;
  // 印を落とした桁が全部 1 なら「大きさは不明」。ヘッダだけ書いて流すときに出てくる
  let allOnes = (first & mask) === mask;
  for (let i = 1; i < length; i++) {
    value = value * 256 + buffer[at + i]!;
    if (buffer[at + i] !== 0xff) allOnes = false;
  }
  if (!keepMarker && allOnes) return { value: UNKNOWN, next: at + length };
  return { value, next: at + length };
}

/** 符号なし整数 (ビッグエンディアン、長さは中身のぶんだけ) */
function uint(body: Uint8Array): number {
  let value = 0;
  for (const byte of body) value = value * 256 + byte;
  return value;
}

/** 文字列 (UTF-8)。**末尾の NUL は落とす** (EBML の文字列は NUL で埋めてよい) */
function text(body: Uint8Array): string {
  return new TextDecoder().decode(body).replace(/\0+$/, "");
}

function float(body: Uint8Array): number {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (body.length === 4) return view.getFloat32(0);
  if (body.length === 8) return view.getFloat64(0);
  return 0;
}

/** `[ID][大きさ]` のヘッダを読む。足りなければ null */
function ebmlHead(buffer: Uint8Array, at: number): EbmlHead | null {
  const id = vint(buffer, at, true);
  if (id === null) return null;
  const size = vint(buffer, id.next, false);
  if (size === null) return null;
  return { id: id.value, size: size.value, body: size.next };
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
  /** 中身の種類 (`V_AV1`・`A_OPUS`・`S_ARIBSUB` など) */
  codecId: string;
  /** WebCodecs の書き方 (`avc1.640028` / `av01.0.08M.08` / `mp4a.40.2` / `opus`)。読めない形式は null */
  codec: string | null;
  /** CodecPrivate (avcC / av1C / AudioSpecificConfig / OpusHead) */
  config: Uint8Array<ArrayBuffer>;
  /** 1 コマの長さ (ナノ秒)。書いていなければ null */
  defaultDuration: number | null;
  name: string;
  language: string;
  width: number;
  height: number;
}

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
    }
  }
  track.codec = codecOf(track);
  return track;
}

/**
 * CodecID と CodecPrivate から WebCodecs の書き方を起こす (`ts/fmp4.ts` の `readEntry` と同じ決まり)。
 * H.265 は互換モードで描かないので読まない (`ts/playback.ts` の `CanvasCodec`)
 */
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
 * デコードする側 (`raw/fmp4.ts`) が受け取る形式にする。コマの時刻は TimestampScale の刻みで渡す。読めない形式なら null。
 * Opus の CodecPrivate はデコーダが受け取る OpusHead のまま渡す (`ts/fmp4.ts` の `opusHead` がそのまま返す)
 */
export function asFmp4Track(track: MkvTrack, scale: number): Fmp4Track | null {
  if (track.codec === null || track.kind === "other") return null;
  // OpusHead は 19 バイトから
  if (track.codec === "opus" && track.config.length < 19) return null;
  return {
    id: track.number,
    kind: track.kind,
    timescale: 1e9 / scale,
    codec: track.codec,
    config: track.config,
    width: track.width,
    height: track.height,
    defaults: { duration: 0, size: 0, flags: 0 },
  };
}

/** 取り出した 1 コマ。時刻は TimestampScale の刻み */
export interface MkvBlock {
  track: number;
  at: number;
  key: boolean;
  data: Uint8Array;
}

/**
 * コマ 1 つ。`[トラック番号(可変長)][先頭からの差(2バイト、符号あり)][フラグ][中身…]`
 *
 * **レーシング (lacing) は来ない。** 1 つのブロックに複数のコマを詰める書き方だが、
 * ffmpeg は映像・音声・字幕では使わない。万一来たら、そのブロックは捨てる。変に読むより
 * 1 コマ落とすほうが害が小さい (字幕は次が来る)
 */
function readBlock(
  body: Uint8Array,
): { track: number; offset: number; flags: number; data: Uint8Array } | null {
  const track = vint(body, 0, false);
  if (track === null || track.next + 3 > body.length) return null;
  const flags = body[track.next + 2]!;
  if ((flags & 0x06) !== 0) return null;
  return {
    track: track.value,
    offset: (u16(body, track.next) << 16) >> 16,
    flags,
    data: body.slice(track.next + 3),
  };
}

/**
 * **流れてくる Matroska から、トラックの形式とコマを取り出す。** 足りないところで止めて続きを待つ
 * (流れてくるものなので、要素の途中で切れているのが普通)。
 * Info と Tracks は丸ごと届いてから読む。Segment・Cluster・BlockGroup と大きさが「不明」のものは中に入り、
 * ほかの要素 (SeekHead・Cues・Tags・Chapters・CRC-32) は大きさぶん飛ばす。字幕トラックのコマも出すので、捨てるのは使う側
 */
export class MkvDemuxer {
  private buffer = new Uint8Array(0);
  /** 時刻の刻み (ナノ秒)。Info に書いてあれば差し替える */
  scale = DEFAULT_SCALE;
  /** いま読んでいる Cluster の先頭の時刻 (刻みの単位) */
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

  /** コマ 1 つ (`readBlock`)。キーフレームの印は SimpleBlock のフラグ。Block のときは `closeGroup` が決める */
  private block(body: Uint8Array): MkvBlock | null {
    const block = readBlock(body);
    if (block === null) return null;
    const { track, offset, flags, data } = block;
    return { track, at: this.base + offset, key: (flags & 0x80) !== 0, data };
  }
}

/** 飛ぶ位置の表の 1 つ (時刻は秒、位置は Segment の中身の先頭から) */
export interface MkvCue {
  time: number;
  position: number;
}

/** ファイルの先頭から読んだもの (`readMkvHead`) */
interface MkvHead {
  /** Segment の中身の先頭 (ファイルの先頭から)。Cues・SeekHead の位置はここから数える */
  segment: number;
  /** 最初の Cluster の位置 (ファイルの先頭から)。ここまでが「先頭」 */
  firstCluster: number;
  scale: number;
  /** 尺 (秒)。書いていなければ null */
  duration: number | null;
  tracks: MkvTrack[];
  /** Cues の位置 (ファイルの先頭から)。SeekHead にも無ければ null */
  cues: number | null;
}

/**
 * ファイルの先頭 (最初の Cluster まで) を読む。**最初の Cluster が `bytes` の中に無ければ null**
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

/** 要素の大きさ (ヘッダも含めて)。ヘッダが読めなければ null */
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

/** `seconds` から観るときに読み始める Cluster。表に無ければ null (先頭から) */
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
