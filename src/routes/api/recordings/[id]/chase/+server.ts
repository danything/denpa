import { error } from "@sveltejs/kit";

import { askedTrack } from "#lib/arib.js";
import { parseId } from "#lib/id.js";
import { chaseStream } from "#lib/server/live.js";
import { askedFormat } from "#lib/server/viewing.js";
import {
  BUSY,
  CODEC_HEADER,
  NO_FORMAT,
  RUNG_HEADER,
} from "#lib/ts/playback.js";

/**
 * **追っかけ再生を HTTP で流す** (画面の外のもの向けのエンドポイント。docs/api.md)。テレビのアプリが、
 * 録画中 (とエンコードが終わる前) の録画を観るのに使う。
 *
 * `?codec=` は `h264` (既定) / `av1` / `raw` / `auto`。`h264` と `av1` は画面の追っかけと同じ再エンコードの
 * fMP4、`raw` はエンコードせずに元の TS (MPEG-2) をそのまま。`auto` は端末が再生できる形式 (`?playable=`) から
 * サーバが「自動」の順で選ぶ (H.265 は出さない。`viewing.askedFormat`)。選べなければ 406。どれも中身の形式を `X-Denpa-Codec` で返す。
 * `?from=<秒>` で先頭からの位置を選ぶ (シークはリクエストし直す)。`?audio=<音声ID>` (一覧の `audios` の `id`) でエンコードする音声を選ぶ
 * (知らないものは主音声、`raw` では効かない)。`?rung=1〜3` で回線に合わせて画質を下げる (`#lib/rungs.ts`。コーデックは `?playable=` から
 * サーバが選ぶ)。伸びているファイルを追い読みし、録り終えて末尾まで読んだら閉じる
 * (`live.ts` の `chaseStream`)。再エンコードはその場の変換の枠 (`server/transcode.ts`) を使い、
 * 埋まっていれば 503
 */
export function GET({ params, url }) {
  const id = parseId(params.id);
  if (id === null) error(400, "録画 ID が不正です");
  const asked = askedFormat(url, "chase");
  if (asked === null) error(406, NO_FORMAT);
  const { codec, rung } = asked;
  const from = Number(url.searchParams.get("from") ?? 0);
  const stream = chaseStream(
    id,
    codec,
    Number.isFinite(from) ? Math.max(0, from) : 0,
    askedTrack(url.searchParams.get("audio")),
    rung,
  );
  if (stream === null) error(404, "録画がないか、まだ何も録画されていません");
  if (stream === "busy") error(503, BUSY);
  return new Response(stream, {
    headers: {
      "Content-Type": codec === "raw" ? "video/mp2t" : "video/mp4",
      "Cache-Control": "no-store",
      [CODEC_HEADER]: codec,
      ...(codec === "raw" ? {} : { [RUNG_HEADER]: String(rung) }),
    },
  });
}
