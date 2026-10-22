import { error } from "@sveltejs/kit";
import { askedTrack } from "#lib/arib.js";
import { chaseStream } from "#lib/server/live.js";
import { BUSY } from "#lib/ts/playback.js";

/**
 * **追っかけ再生を HTTP で流す** (画面の外のもの向けのエンドポイント。docs/api.md)。テレビのアプリが、
 * 録画中 (とエンコードが終わる前) の録画を観るのに使う。
 *
 * `?codec=` は `h264` (既定) / `av1` / `raw`。`h264` と `av1` は画面の追っかけと同じ再エンコードの
 * fMP4、`raw` はエンコードせずに元のTS (MPEG-2) をそのまま。`?from=<秒>` で頭からの位置を選ぶ
 * (シークはリクエストし直す)。`?audio=<音声ID>` (一覧の `audios` の `id`) でエンコードする音声を選ぶ (知らないものは主音声、
 * `raw` では効かない)。伸びているファイルを追い読みし、録り終えて尻まで読んだら閉じる
 * (`live.ts` の `chaseStream`)。再エンコードはその場の変換の枠 (`server/transcode.ts`) を使い、
 * 埋まっていれば 503
 */
export function GET({ params, url }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) error(400, "録画IDが不正です");
  const asked = url.searchParams.get("codec");
  const codec = asked === "av1" || asked === "raw" ? asked : "h264";
  const from = Number(url.searchParams.get("from") ?? 0);
  const stream = chaseStream(
    id,
    codec,
    Number.isFinite(from) ? Math.max(0, from) : 0,
    askedTrack(url.searchParams.get("audio")),
  );
  if (stream === null) error(404, "録画がないか、まだ何も録画されていません");
  if (stream === "busy") error(503, BUSY);
  return new Response(stream, {
    headers: {
      "Content-Type": codec === "raw" ? "video/mp2t" : "video/mp4",
      "Cache-Control": "no-store",
    },
  });
}
