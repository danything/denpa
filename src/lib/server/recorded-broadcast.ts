/**
 * **録画の放送のコーデック** (`#lib/live-choice.ts` の `BroadcastCodec`)。追っかけと録画の観る画面は、開く前にこれで形式を決める
 * (`live.chaseForm`・`playback.playbackPlan`)。開いたあとで形式を替えるのは、決まらないまま元の TS で開いた追っかけだけ (下)。
 *
 * - 4K の局の録画 (`.mmts`) は `hevc`
 * - TS の録画 (`.m2ts`) は、先頭の PMT の映像が HEVC なら `hevc` (TS で送る 4K の局。docs/stream.md「TS で送る 4K の局」)、ほかは `mpeg2`。
 *   PMT をまだ読めない (録り始めたばかり)・ファイルを開けないときも `mpeg2`
 *
 * 同じ PMT から、映像と音声があるかも決める (`recordedMedia`。ラジオ・データ放送の局の録画)。先頭の PMT に映像が無ければ、
 * 録画を等分した位置の PMT も読む (`readMedia`。番組の途中で映像が付く録画を、映像の無い録画にしない)。
 *
 * 局の行にも録画の行にも覚えない。読んで決まった答えを、録画のパスごとにメモリに覚える。録り始めたばかりで決まらなかった録画は、
 * `UNDECIDED_WAIT` を過ぎてから開くときに読み直す。決まらないまま元の TS で開いた追っかけは、送る前にセッションが
 * 録画のストリームから PMT を読み (`live.Session` の `learnsBroadcast`)、読めた答えをここに覚える (`learnBroadcast`)
 */

import { type BroadcastCodec, broadcastCodec } from "#lib/live-choice.js";
import { recordedTransport } from "#lib/source.js";
import type { ServiceVideo } from "#lib/types.js";

import { PmtPeek } from "./captions";
import { keepNewest } from "./expiring";
import {
  openRecordingSync,
  recordingSize,
  type RecordingSyncHandle,
} from "./recording-io";

/**
 * PMT を探して先頭から読む量 (バイト)。放送は PMT を 100 ms ごとに流すので、ふつうは最初の数百 KB で見つかる。
 * 4K の HEVC は 1 局で約 33 Mbit/s あり、4 MB は 1 秒ぶんほど
 */
const PMT_SEARCH = 4 * 1024 * 1024;

/** 1 回に読む量 (TS のパケット 1024 個) */
const READ_CHUNK = 188 * 1024;

/** 覚えておく録画の数。超えたら古いものから捨てる (捨てたものは次に開くときに読み直す) */
const KEEP = 512;

/**
 * PMT を読めなかった録画を、次に読み直すまでの間 (ms)。読むのは同期で最大 `PMT_SEARCH` なので、
 * 追っかけを続けて開き直す間 (シーク・音声の選び直し) は読み直さない。録り始めたばかりの録画も、この間には PMT が書かれる
 */
export const UNDECIDED_WAIT = 5_000;

/** 読んで決まった答え (録画のパスごと) */
const decided = new Map<string, BroadcastCodec>();

/** PMT を読めなかった録画と、読んだ時刻 */
const undecided = new Map<string, number>();

/** 覚えるものを足す。`KEEP` を超えたら古いものから捨てる */
function remember<T>(map: Map<string, T>, path: string, value: T): void {
  keepNewest(map, path, value, KEEP);
}

/**
 * **録画の放送のコーデック。** TS の録画は先頭の PMT を読んで決める (`readMedia`。先頭に映像が無ければ、映像のあった最初の PMT)。
 * PMT を読めなかった録画は `UNDECIDED_WAIT` の間は読み直さず、MPEG-2 の局の録画として扱う
 * @param program その局の放送の番号 (ARIB のサービス ID。`encoder.aribServiceId`)。0 なら PMT を探さない
 */
export function recordedBroadcast(
  path: string,
  program: number,
  now = Date.now(),
): BroadcastCodec {
  const transport = recordedTransport(path);
  if (transport === "tlv") return broadcastCodec(transport);
  const held = decided.get(path);
  if (held !== undefined) return held;
  const tried = undecided.get(path);
  if (tried !== undefined && now - tried < UNDECIDED_WAIT)
    return broadcastCodec(transport);
  const media = readMedia(path, program);
  // PMT をまだ読めない。今までどおり MPEG-2 の局として扱い、少し置いてから読み直す
  if (media === undefined) {
    remember(undecided, path, now);
    return broadcastCodec(transport);
  }
  undecided.delete(path);
  const broadcast = codecOf(media);
  remember(decided, path, broadcast);
  remember(contents, path, {
    media: { video: media.video !== null, audio: media.audio },
    size: media.size,
  });
  return broadcast;
}

/** 録画に映像と音声があるか (`recordedMedia`) */
interface RecordedMedia {
  video: boolean;
  audio: boolean;
}

/**
 * 読んで決まった映像と音声の有る無し (録画のパスごと)。`recordedBroadcast` と同じ PMT から。
 * `size` は読んだときの録画の大きさ (映像の無い答えを読み直すかに使う。`recordedMedia`)
 */
const contents = new Map<string, { media: RecordedMedia; size: number }>();

/**
 * **録画に映像と音声があるか。** TS の録画は PMT を読んで決め、読めた答えを覚える (`readMedia`。`recordedBroadcast` と同じ PMT)。
 * 映像の無い録画 (ラジオ・データ放送の局) はエンコードせず元の TS を置き (`recorder.finish`)、観る画面は音声だけで流す
 * (音声も無ければ無音。`playback.playbackPlan`)。
 *
 * - **覚えていなければ、そのたびに PMT を読む。** `recordedBroadcast` の読み直しの間 (`UNDECIDED_WAIT`) は待たない。
 *   追っかけが放送のコーデックだけを覚えた録画 (`learnBroadcast`) と、録り始めに PMT を読めなかった録画でも、録り終えたときに読み直して決める
 * - **映像の無い答えは、録画の大きさが読んだときと違えば読み直す。** 録っている最中に追っかけが読んだ答えのままだと、
 *   そのあとで映像が付いた録画を、録り終えたときに映像の無い録画として置いてしまう
 * - 4K の局の録画 (`.mmts`) は両方ある
 * - **PMT を読めない録画 (まだ書かれていない・壊れている) は、両方あるものとして扱う。** テレビの録画が今までどおりエンコードに回るように。
 *   映像の無い録画を取り違えてエンコードしても、エンコードが失敗するだけで元の TS は残る
 */
export function recordedMedia(path: string, program: number): RecordedMedia {
  const both = { video: true, audio: true };
  if (recordedTransport(path) === "tlv") return both;
  const held = contents.get(path);
  if (
    held !== undefined &&
    (held.media.video || held.size === recordingSize(path))
  )
    return held.media;
  const media = readMedia(path, program);
  if (media === undefined) return held?.media ?? both;
  const found = { video: media.video !== null, audio: media.audio };
  remember(contents, path, { media: found, size: media.size });
  // 放送のコーデックも同じ PMT で決まる。まだ覚えていないか、映像の無い答えから読み直したなら覚える
  if (!decided.has(path) || held !== undefined) {
    undecided.delete(path);
    remember(decided, path, codecOf(media));
  }
  return found;
}

/**
 * **録画の放送のコーデックが決まっているか。** 4K の局の録画 (`.mmts`) と、PMT を読めて覚えている TS の録画は true。
 * 録り始めたばかりで PMT をまだ読めていない TS の録画は false で、追っかけを元の TS で開くときは送る前に PMT を読む (`live.openChase`)
 */
export function broadcastDecided(path: string): boolean {
  return recordedTransport(path) === "tlv" || decided.has(path);
}

/**
 * **追っかけのセッションが録画のストリームから読んだ放送のコーデックを覚える** (`live.Session` の `learnsBroadcast`)。
 * 次に開くときは読み直さずにこれで形式を決める (`recordedBroadcast`)
 */
export function learnBroadcast(path: string, broadcast: BroadcastCodec): void {
  undecided.delete(path);
  remember(decided, path, broadcast);
}

/**
 * 先頭の PMT に映像が無い録画で、ほかに PMT を読む位置の数。録画を `MEDIA_SAMPLES` 等分した区切り (先頭を除く) から読む。
 * 映像の無い局の録画は小さい (映像のぶんが無い) ので、読み足しても軽い
 */
const MEDIA_SAMPLES = 8;

/** 読んだ PMT の映像のコーデックと音声の有る無し */
interface PmtMedia {
  video: ServiceVideo | null;
  audio: boolean;
}

/** PMT の映像が HEVC なら `hevc` (TS で送る 4K の局)、ほかは `mpeg2` */
function codecOf(media: PmtMedia): BroadcastCodec {
  return media.video === "hevc" ? "hevc" : "mpeg2";
}

/**
 * **TS の録画の PMT から、映像のコーデックと音声の有る無しを読む** (`captions.PmtPeek`)。先頭の PMT を読めなければ undefined。
 *
 * **先頭の PMT に映像が無ければ、録画を等分した位置 (`MEDIA_SAMPLES`) の PMT も読み、どれかに映像があれば映像のある録画とする。**
 * 番組の途中で PMT が変わって映像が付く録画 (録り始めは映像の ES が無かった) を、先頭だけで映像の無い録画にしないため。
 * 映像のコーデックは、映像のあった最初の PMT のもの。音声は読んだ PMT のどれかにあれば有る。
 * 等分した位置の間だけ映像が付いて外れた録画は、映像の無い録画のまま (そこまでは読まない)。
 * 先頭の PMT に映像があればそこで決め、ほかは読まない (テレビの録画は大きく、先頭で決まる)。あとで映像が外れる録画は、
 * 映像のある録画としてエンコードに回る (映像のある所はエンコードされる)
 *
 * @returns 読んだときの録画の大きさ (`size`) も添える
 */
function readMedia(
  path: string,
  program: number,
): (PmtMedia & { size: number }) | undefined {
  if (program <= 0) return undefined;
  const size = recordingSize(path);
  if (size === null) return undefined;
  return withRecording(path, (handle) => {
    const head = peekAt(handle, program, 0, PMT_SEARCH);
    if (head === undefined) return undefined;
    if (head.video !== null) return { ...head, size };
    let audio = head.audio;
    for (let k = 1; k < MEDIA_SAMPLES; k++) {
      // パケットの切れ目から読む (TS は 188 バイトのパケットの並び)
      const at = Math.floor((size * k) / MEDIA_SAMPLES / 188) * 188;
      const found = peekAt(handle, program, at, at + PMT_SEARCH);
      if (found === undefined) continue;
      audio ||= found.audio;
      if (found.video !== null) return { video: found.video, audio, size };
    }
    return { video: null, audio, size };
  });
}

/** 録画を同期で開いて `read` に渡す。開けない・読めなければ undefined */
function withRecording<T>(
  path: string,
  read: (handle: RecordingSyncHandle) => T | undefined,
): T | undefined {
  let handle: RecordingSyncHandle;
  try {
    handle = openRecordingSync(path);
  } catch {
    return undefined;
  }
  try {
    return read(handle);
  } catch {
    return undefined;
  } finally {
    handle.close();
  }
}

/** 録画の `from` バイト目から `limit` バイト目の手前までで、その局の最初の PMT を読む。無ければ undefined */
function peekAt(
  handle: RecordingSyncHandle,
  program: number,
  from: number,
  limit: number,
): PmtMedia | undefined {
  const peek = new PmtPeek(program);
  for (let at = from; at < limit;) {
    // 渡した塊は PmtPeek が持ち越すことがあるので、読むたびに新しく取る
    const chunk = new Uint8Array(Math.min(READ_CHUNK, limit - at));
    const read = handle.read(chunk, 0, chunk.length, at);
    if (read <= 0) return undefined;
    if (peek.feed(chunk.subarray(0, read)) !== null)
      return { video: peek.video, audio: peek.audio === true };
    at += read;
  }
  return undefined;
}
