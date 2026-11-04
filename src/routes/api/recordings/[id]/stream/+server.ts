import { streamResponse } from "#lib/server/playback.js";
import { recordingOr404 } from "#lib/server/recording.js";

/**
 * **録画をその場で流す** (`server/playback.ts`)。
 *
 * - `?codec=h264` / `hevc` / `av1` … fMP4。エンコード済みと同じコーデックなら詰め替えるだけ、違えば変換
 *   (その場の変換の枠を使う。埋まっていれば 503)。`hevc` は詰め替えだけ
 * - `?codec=mpeg2` … 元の TS を飛び先からそのまま。物差しの 0 にあたる PTS を `X-Denpa-Origin` で返す
 *
 * - `?codec=audio` … 音声だけの fMP4 (AAC 96k。回線が段 3 でも足りないとき)
 *
 * `?from=<秒>` は物差し (`playback` の `axis`) の上の位置 (シークはリクエストし直す)。
 * `?audio=<id>` は `playback` の `audios` の `id` (MPEG-2 では効かない。全部の音声を流す)。
 * `?rung=1〜3` は回線に合わせて下げた段で、コーデックは `?playable=` からサーバが選ぶ (応答ヘッダ `X-Denpa-Codec`)。
 * 送り出しの具合は応答ヘッダ `X-Denpa-Pace` の id で `GET /api/playback/pace?id=` から読む
 */
export function GET({ params, url }) {
  return streamResponse(recordingOr404(params.id), url.searchParams);
}
