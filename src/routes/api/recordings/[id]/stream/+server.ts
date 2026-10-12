import { streamResponse } from '#lib/server/playback.js';
import { recordingOr404 } from '#lib/server/recording.js';

/**
 * **録画をその場で流す** (`server/playback.ts`)。
 *
 * - `?codec=h264` / `av1` … fMP4。エンコード済みと同じコーデックなら詰め替えるだけ、違えば変換
 *   (その場の変換の枠を使う。埋まっていれば 503)
 * - `?codec=mpeg2` … 元の TS を飛び先からそのまま。物差しの 0 にあたる PTS を `X-Denpa-Origin` で返す
 *
 * `?from=<秒>` は物差し (`playback` の `axis`) の上の位置 (シークはリクエストし直す)。
 * `?audio=<id>` は `playback` の `audios` の `id` (MPEG-2 では効かない。全部の音声を流す)
 */
export function GET({ params, url }) {
    return streamResponse(recordingOr404(params.id), url.searchParams);
}
