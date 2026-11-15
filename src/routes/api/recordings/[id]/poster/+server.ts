import { readFileSync, statSync } from "node:fs";

import { error } from "@sveltejs/kit";

import { sidecarPaths } from "#lib/server/metadata.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { etagMatches, fileEtag } from "#lib/server/serve.js";

/**
 * 録画のポスターを返す。**一覧のサムネイル用。**
 *
 * エンコードのときに動画の隣へ置いてある `-poster.jpg` (`server/metadata.ts`)
 * をそのまま配る。ffmpeg は起こさない。エンコードしたときに
 * 作ってあるので、読んで返すだけ。
 *
 * **無い録画もある。** ポスターより前にエンコードしたもの、エンコードする前のもの、4K の局をエンコードせずに置いたもの、切り出しに
 * 失敗したもの。そのときは 404 を返して、一覧は画像を出さずに済ませる (`home/Poster.svelte`)。
 *
 * **持たせてよいが、毎回確かめさせる** (チャプターと同じ)。再エンコードすると同じ名前に書き直し、CM の検出が変われば取る位置も変わる。
 * `no-cache` + ETag (ファイルの大きさと更新時刻) にして、変わっていなければ 304
 */
export function GET({ params, request }) {
  const recording = recordingOr404(params.id);
  if (recording.library_path === null) error(404, "ポスターがありません");

  const poster = sidecarPaths(recording.library_path).thumbnail;
  const stat = statSync(poster, { throwIfNoEntry: false });
  if (stat === undefined) error(404, "ポスターがありません");

  const headers = {
    "Content-Type": "image/jpeg",
    "Cache-Control": "private, no-cache",
    ETag: fileEtag(stat),
  };
  if (etagMatches(request, headers.ETag))
    return new Response(null, { status: 304, headers });
  return new Response(readFileSync(poster), { headers });
}
