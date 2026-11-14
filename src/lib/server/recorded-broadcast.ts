/**
 * **録画の放送のコーデック** (`#lib/live-choice.ts` の `BroadcastCodec`)。追っかけと録画の観る画面は、開く前にこれで形式を決める
 * (`live.chaseForm`・`playback.playbackPlan`)。開いたあとで形式を替える仕組みは持たない。
 *
 * - 4K の局の録画 (`.mmts`) は `hevc`
 * - TS の録画 (`.m2ts`) は、先頭の PMT の映像が HEVC なら `hevc` (TS で送る 4K の局。docs/stream.md「TS で送る 4K の局」)、ほかは `mpeg2`。
 *   PMT をまだ読めない (録り始めたばかり)・ファイルを開けないときも `mpeg2`
 *
 * 局の行にも録画の行にも覚えない。読んで決まった答えを、録画のパスごとにメモリに覚える。録り始めたばかりで決まらなかった録画は、
 * `UNDECIDED_WAIT` を過ぎてから開くときに読み直す
 */

import { type BroadcastCodec, broadcastCodec } from "#lib/live-choice.js";
import { recordedTransport } from "#lib/source.js";
import type { ServiceVideo } from "#lib/types.js";

import { PmtPeek } from "./captions";
import { openRecordingSync } from "./recording-io";

/**
 * PMT を探して先頭から読む量 (バイト)。放送は PMT を 100ms ごとに流すので、ふつうは最初の数百 KB で見つかる。
 * 4K の HEVC は 1 局で約 33Mbit/s あり、4MB は 1 秒ぶんほど
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
  map.delete(path);
  if (map.size >= KEEP) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(path, value);
}

/**
 * **録画の放送のコーデック。** TS の録画は先頭の PMT を読んで決める (`headVideo`)。
 * PMT を読めなかった録画は `UNDECIDED_WAIT` の間は読み直さず、MPEG-2 の局の録画として扱う
 * @param program その局の放送の番号 (ARIB のサービス ID。`live.aribServiceId`)。0 なら PMT を探さない
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
  const video = headVideo(path, program);
  // PMT をまだ読めない。今までどおり MPEG-2 の局として扱い、少し置いてから読み直す
  if (video === undefined) {
    remember(undecided, path, now);
    return broadcastCodec(transport);
  }
  undecided.delete(path);
  const broadcast: BroadcastCodec = video === "hevc" ? "hevc" : "mpeg2";
  remember(decided, path, broadcast);
  return broadcast;
}

/**
 * **TS の録画の先頭 `limit` バイトから、その局の PMT の映像のコーデックを読む** (`captions.PmtPeek`)。
 * PMT を読めなければ undefined (まだ書かれていない・開けない)。映像の無い PMT は null
 */
export function headVideo(
  path: string,
  program: number,
  limit = PMT_SEARCH,
): ServiceVideo | null | undefined {
  if (program <= 0) return undefined;
  let handle: ReturnType<typeof openRecordingSync>;
  try {
    handle = openRecordingSync(path);
  } catch {
    return undefined;
  }
  try {
    const peek = new PmtPeek(program);
    for (let at = 0; at < limit;) {
      // 渡した塊は PmtPeek が持ち越すことがあるので、読むたびに新しく取る
      const chunk = new Uint8Array(Math.min(READ_CHUNK, limit - at));
      const read = handle.read(chunk, 0, chunk.length, at);
      if (read <= 0) return undefined;
      if (peek.feed(chunk.subarray(0, read)) !== null) return peek.video;
      at += read;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    handle.close();
  }
}
