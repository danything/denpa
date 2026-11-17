/**
 * **詰め替え (`playback.copyArgs`) を始める位置を、始めてよいコマ (`ts/random-access.startable`) に寄せる。**
 *
 * 詰め替えは `-ss` を `-i` の前に置いて映像を写すので、ffmpeg は Matroska の Cues で `from` の手前の
 * キーフレームから出す。Cues と印はエンコーダが付けたもので、MediaCodec でエンコードした録画では
 * P のコマ (intra-refresh の回復点) にも付いていることがある (`ts/random-access.ts`)。
 *
 * - `from` の手前のキーフレームから始めてよいなら、`from` をそのまま返す。ほとんどの録画はここで終わる
 * - そうでなければ、Cues を手前へたどって最初に見つかった始めてよいキーフレームの、少し後ろ (`AIM`) の時刻を返す。
 *   ffmpeg は `-ss` の手前のキーフレームを選ぶので、そのコマから出す
 * - `LOOKBACK` 秒たどっても無ければ `missing`。呼ぶ側は詰め替えずに変換する (`playback.ts`)
 * - Cues が無い・読めない・AV1 なら、`from` をそのまま返し、印も直さない (`marks` が null。前と同じ)
 *
 * 寄せるだけでは足りない。WebKit は目標の時刻の手前でいちばん近い sync のコマからデコーダに渡すので、出した fMP4 の
 * sync の印も始めてよいコマにだけ残す (`marks` を `ts/fmp4-marks.ts` に渡す)。
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
  type NalCodec,
  nalLengthSize,
  startable,
} from "#lib/ts/random-access.js";

import { readRecording } from "./recording-io";

const CLUSTER_STEP = 512 * 1024;
const CLUSTER_MOST = 16 * 1024 * 1024;
/**
 * 始めてよいキーフレームを探して手前へたどる長さ (秒)。**観はじめの遅れで決めた。**
 *
 * 手前のキーフレームから送ると、WebKit はそこから開いた位置までをデコードし直してから映し、そのぶんを送る時間も掛かる。
 * macOS の WebKit (GitHub の Mac のランナー。1080p59.94) では、開いた位置から映るまで、間が 30 秒で 9 秒、50 秒で 13 秒、
 * 58 秒で 14.5 秒掛かった (間が数秒なら 1.5〜2.5 秒。送る時間は入っていない)。MediaCodec の 1080p は 10.5 Mbit/s なので、
 * 間が 20 秒なら 26 MB 多く送る (50 Mbit/s で 4 秒)。20 秒までなら、見積もりで 10 秒ほどで映る。それより遠ければ変換する (変換の枠を使う)
 */
const LOOKBACK = 20;
/**
 * 選んだキーフレームより、これだけ後ろの時刻を `-ss` に渡す (秒。次のキーフレームが近ければその半分)。
 * ffmpeg は B フレームのある映像では `-ss` の 3/23 秒手前で探す (fftools/ffmpeg_demux.c の `dts_heuristic`) ので、
 * ちょうどの時刻を渡すと 1 つ手前のキーフレームから出してしまう
 */
const AIM = 0.5;

/** Matroska の CodecID から、始めてよいコマを見分けられるコーデックへ */
function nalCodec(codecId: string): NalCodec | null {
  if (codecId === "V_MPEG4/ISO/AVC") return "h264";
  if (codecId === "V_MPEGH/ISO/HEVC") return "hevc";
  return null;
}

/** 印を直すのに要るもの (`ts/fmp4-marks.ts` の `SyncMarks` に渡す) */
export interface Marks {
  codec: NalCodec;
  lengthSize: number;
}

/** **詰め替えの始め方** (`cleanFrom`) */
export type CleanStart =
  | {
      /** 詰め替えてよい */
      missing: false;
      /** ffmpeg に渡す `-ss` (秒) */
      from: number;
      /** 出した fMP4 の sync の印を直すのに要るもの。H.264・H.265 の中身を読めたときだけ。null なら直さない */
      marks: Marks | null;
    }
  | {
      /** 手前 `LOOKBACK` 秒に始めてよいキーフレームが無い。詰め替えると WebKit が始められない */
      missing: true;
      /** 開く位置 (秒)。変換できずに詰め替えるときは、ここから印を直さずに詰め替える (前と同じ) */
      from: number;
      marks: Marks;
      /**
       * 変換を始める位置 (秒)。`from` の手前のキーフレームの 1 つ前から読ませる。印の付いた P のコマから読むと、
       * ffmpeg のデコーダは画が揃う (回復点の SEI が示すコマ数を過ぎる) まで出さないので、1 つ前のキーフレームから読んで
       * `from` より前に揃える。`-ss` の位置より前は出さないので、出る映像は `from` の少し手前から始まる
       */
      decodeFrom: number;
    };

interface Index extends Marks {
  track: number;
  /** Segment の中身の先頭 (ファイルの先頭から)。Cues の位置はここから数える */
  segment: number;
  /** 時刻の刻み (ナノ秒) */
  scale: number;
  cues: MkvCue[];
}

/**
 * 先頭と Cues を読む。H.264・H.265 でない・Cues が無い・先頭が読めなければ null。Cues の中身が読めなければ `cues` は空
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
 * `cue` の指すキーフレーム。読めなければ null。
 * Cue は Cluster の先頭を指すが、キーフレームが Cluster の途中にあることもある (ffmpeg は Cluster を大きさと長さでも区切る) ので、
 * Cluster の先頭から読んで、時刻が Cue と同じ映像のコマを探す
 */
async function keyFrame(
  path: string,
  index: Index,
  cue: MkvCue,
): Promise<Uint8Array | null> {
  const demuxer = new MkvDemuxer();
  const at = index.segment + cue.position;
  for (let read = 0; read < CLUSTER_MOST; read += CLUSTER_STEP) {
    const chunk = await readRecording(path, at + read, CLUSTER_STEP);
    if (chunk.length === 0) break;
    for (const block of demuxer.feed(chunk).blocks) {
      if (block.track !== index.track) continue;
      const time = (block.at * index.scale) / 1e9;
      if (Math.abs(time - cue.time) < 1e-6) return block.data;
    }
  }
  return null;
}

/** **詰め替えの始め方** (冒頭の説明)。`from` の手前のキーフレームから始められなければ、手前の始めてよいキーフレーム */
export async function cleanFrom(
  path: string,
  from: number,
): Promise<CleanStart> {
  const asIs: CleanStart = { missing: false, from, marks: null };
  try {
    const index = await readIndex(path);
    if (index === null) return asIs;
    const marks = { codec: index.codec, lengthSize: index.lengthSize };
    // 先頭から出すときは、ファイルの最初のコマから出る。規格で IDR と決まっている
    if (from <= 0) return { from, marks, missing: false };
    const { cues } = index;
    const last = cues.findLastIndex((cue) => cue.time <= from);
    if (last < 0) return { from, marks, missing: false };
    for (let i = last; i >= 0; i--) {
      const cue = cues[i]!;
      if (cue.time < from - LOOKBACK) break;
      const key = await keyFrame(path, index, cue);
      if (key === null) return asIs;
      if (!startable(index.codec, index.lengthSize, key)) continue;
      if (i === last) return { from, marks, missing: false };
      const next = cues[i + 1]?.time ?? Number.POSITIVE_INFINITY;
      const start =
        Math.ceil((cue.time + Math.min(AIM, (next - cue.time) / 2)) * 1000) /
        1000;
      console.log(
        `詰め替えを ${from.toFixed(3)} 秒の手前の始められるキーフレーム (${cue.time.toFixed(3)} 秒) から始めます`,
      );
      return { from: start, marks, missing: false };
    }
    // LOOKBACK 秒の中に無かった (先頭のキーフレームまで来ていれば、そこは IDR なので見つかっている)
    const before = cues[last - 1];
    const decodeFrom =
      before === undefined
        ? from
        : Math.min(
            from,
            Math.ceil(
              (before.time +
                Math.min(AIM, (cues[last]!.time - before.time) / 2)) *
                1000,
            ) / 1000,
          );
    return { from, marks, missing: true, decodeFrom };
  } catch {
    return asIs;
  }
}
