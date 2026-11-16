/**
 * **詰め替え (`playback.copyArgs`) を始める位置を、IDR のキーフレームに寄せる。**
 *
 * 詰め替えは `-ss` を `-i` の前に置いて映像を写すので、ffmpeg は Matroska の Cues で `from` の手前の
 * キーフレームから出す。Cues と印はエンコーダが付けたもので、MediaCodec でエンコードした録画では
 * IDR でないコマにも付いていることがある (`ts/random-access.ts`)。そこから始めると、手前のコマを参照するコマが混ざる。
 *
 * - `from` の手前のキーフレームが IDR (H.265 は RASL の続かない CRA・BLA も) なら、`from` をそのまま返す。
 *   ほとんどの録画はここで終わり、ffmpeg に渡す引数は前と変わらない
 * - そうでなければ、Cues を手前へたどって最初に見つかった IDR の、少し後ろ (`AIM`) の時刻を返す。
 *   ffmpeg は `-ss` の手前のキーフレームを選ぶので、その IDR から出す
 * - たどるのは `LOOKBACK` 秒まで。見つからない・Cues が無い・読めない・AV1 なら、`from` をそのまま返す (前と同じ)
 *
 * すでにエンコードした録画にも効く。読むのは先頭と Cues と、たどったキーフレームの Cluster の先頭だけ
 */

import {
  loadCues,
  loadMkvHead,
  type MkvCue,
  MkvDemuxer,
  type ReadAt,
} from "#lib/ts/mkv-media.js";
import {
  cleanStart,
  type NalCodec,
  nalLengthSize,
} from "#lib/ts/random-access.js";

import { readRecording } from "./recording-io";

/** Cluster を読む単位と上限 (バイト)。キーフレームとその次のコマが入るまで読む */
const CLUSTER_STEP = 512 * 1024;
const CLUSTER_MOST = 16 * 1024 * 1024;
/**
 * IDR を探して手前へたどる長さ (秒)。録画のキーフレームの間隔は 8 秒ほど (`-g 250`) なので、7 つほど見る。
 * これより手前から出すと、観はじめるまでに送るぶんが増える
 */
const LOOKBACK = 60;
/**
 * 選んだキーフレームより、これだけ後ろの時刻を `-ss` に渡す (秒。次のキーフレームが近ければその半分)。
 * ffmpeg は B フレームのある映像では `-ss` の 3/23 秒手前で探す (fftools/ffmpeg_demux.c の `dts_heuristic`) ので、
 * ちょうどの時刻を渡すと 1 つ手前のキーフレームから出してしまう
 */
const AIM = 0.5;

/** Matroska の CodecID から、IDR を見分けられるコーデックへ */
function nalCodec(codecId: string): NalCodec | null {
  if (codecId === "V_MPEG4/ISO/AVC") return "h264";
  if (codecId === "V_MPEGH/ISO/HEVC") return "hevc";
  return null;
}

interface Index {
  codec: NalCodec;
  lengthSize: number;
  track: number;
  /** Segment の中身の先頭 (ファイルの先頭から)。Cues の位置はここから数える */
  segment: number;
  /** 時刻の刻み (ナノ秒) */
  scale: number;
  cues: MkvCue[];
}

/**
 * 先頭と Cues を読む。H.264・H.265 でない・Cues が無い・先頭が読めなければ null。Cues の中身が読めなければ `cues` は空
 * (`cleanFrom` はどちらも `from` をそのまま返す)
 */
async function readIndex(path: string): Promise<Index | null> {
  const read: ReadAt = (offset, length) => readRecording(path, offset, length);
  const head = await loadMkvHead(read);
  if (head === null || head.cues === null) return null;
  const video = head.tracks.find((t) => t.kind === "video");
  const codec = video === undefined ? null : nalCodec(video.codecId);
  if (video === undefined || codec === null) return null;
  const lengthSize = nalLengthSize(codec, video.config);
  if (lengthSize === null) return null;
  const cues = await loadCues(read, head, video.number);
  return {
    codec,
    lengthSize,
    track: video.number,
    segment: head.segment,
    scale: head.scale,
    cues,
  };
}

/**
 * `cue` の指すキーフレームと、デコードの順で次の映像のコマ。読めなければ null。
 * Cue は Cluster の先頭を指すが、キーフレームが Cluster の途中にあることもある (ffmpeg は Cluster を大きさと長さでも区切る) ので、
 * Cluster の先頭から読んで、時刻が Cue と同じ映像のコマを探す
 */
async function keyAndNext(
  path: string,
  index: Index,
  cue: MkvCue,
): Promise<{ key: Uint8Array; next: Uint8Array | null } | null> {
  const demuxer = new MkvDemuxer();
  const at = index.segment + cue.position;
  const frames: Uint8Array[] = [];
  for (let read = 0; read < CLUSTER_MOST; read += CLUSTER_STEP) {
    const chunk = await readRecording(path, at + read, CLUSTER_STEP);
    if (chunk.length === 0) break;
    for (const block of demuxer.feed(chunk).blocks) {
      if (block.track !== index.track) continue;
      const time = (block.at * index.scale) / 1e9;
      if (frames.length > 0 || Math.abs(time - cue.time) < 1e-6)
        frames.push(block.data);
    }
    if (frames.length >= 2) break;
  }
  const [key, next = null] = frames;
  return key === undefined ? null : { key, next };
}

/** **詰め替えを始める位置 (秒)。** `from` の手前のキーフレームが IDR でなければ、手前の IDR の時刻 */
export async function cleanFrom(path: string, from: number): Promise<number> {
  if (from <= 0) return from;
  try {
    const index = await readIndex(path);
    if (index === null) return from;
    const { cues } = index;
    const last = cues.findLastIndex((cue) => cue.time <= from);
    for (let i = last; i >= 0; i--) {
      const cue = cues[i]!;
      if (cue.time < from - LOOKBACK) break;
      const frames = await keyAndNext(path, index, cue);
      if (frames === null) return from;
      if (!cleanStart(index.codec, index.lengthSize, frames.key, frames.next))
        continue;
      const next = cues[i + 1]?.time ?? Number.POSITIVE_INFINITY;
      const start =
        Math.ceil((cue.time + Math.min(AIM, (next - cue.time) / 2)) * 1000) /
        1000;
      if (i === last) return from;
      console.log(
        `詰め替えを ${from.toFixed(3)} 秒の手前の IDR (${cue.time.toFixed(3)} 秒) から始めます`,
      );
      return start;
    }
    return from;
  } catch {
    return from;
  }
}
