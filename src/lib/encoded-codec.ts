/**
 * 置き場の名前 (`… [H264].mkv`) からコーデックを見分ける (`server/library.ts` の `encodedPath` の逆)。
 * サーバと画面の両方で使う (画面は「端末に保存」でどちらを落とすか決めるのに使う。`offline.svelte.ts`)
 */
export function encodedCodec(path: string): "av1" | "h264" | "mpeg2" {
  // エンコードしない録画は元のTS (`.m2ts`) をそのまま保存先に置く (`recorder.ts`)
  if (/\.m2ts$/i.test(path)) return "mpeg2";
  return / \[H264\]\.mkv$/i.test(path) ? "h264" : "av1";
}
