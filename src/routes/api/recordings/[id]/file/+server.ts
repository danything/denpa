import { error } from "@sveltejs/kit";

import { config } from "#lib/server/config.js";
import { activeEncodeJob } from "#lib/server/encoder.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { serveFile } from "#lib/server/serve.js";
import { ffmpegBody } from "#lib/server/stream.js";
import { type FileSource, parseFileSource } from "#lib/source.js";

/**
 * **音声だけ** (`?audio=only`)。音声だけで鳴らすもの (スマートスピーカーへの Cast など) 向け。
 * 元がどれ (元のTS・AV1・H.264) でも同じ形式で出せるよう、主音声を AAC に再エンコードして ADTS で流す。
 * 音声だけなので軽い。閉じられたら ffmpeg も止める
 */
function audioOnly(path: string, request: Request): Response {
  const headers = { "Content-Type": "audio/aac", "Cache-Control": "no-store" };
  // HEAD はヘッダーだけ答える。再エンコードを起こさない
  if (request.method === "HEAD") return new Response(null, { headers });
  const body = ffmpegBody(
    [
      config.ffmpeg,
      "-hide_banner",
      "-nostats",
      "-loglevel",
      "error",
      "-i",
      path,
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-f",
      "adts",
      "pipe:1",
    ],
    `[audio] 音声だけの取り出し ${path}`,
  );
  return new Response(body, { headers });
}

/**
 * 録画ファイルをそのまま配る。
 * プレイヤーに URL を渡して直接再生させるためのエンドポイント。
 */
function respond(
  id: string,
  request: Request,
  source: FileSource | null,
  audio = false,
): Response {
  const recording = recordingOr404(id);

  /*
   * どのファイルを配るか。
   *
   * 基本はエンコード済み、無ければ元のTS。ただし**エンコードを待っている間・走っている間は
   * 元のTSのほう**を配る。再エンコードを待っている間は library_path がまだ古いファイルを
   * 指していて、しかもその古いファイルは走り出すときに消える (`encoder.runJob`) ので、
   * 押した瞬間によって出るものが変わっていた
   */
  const encoding = activeEncodeJob(recording.id) !== undefined;
  /*
   * **どちらを寄越すか、名指しもできる** (`?source=ts` / `encoded` / `alt`)。
   *
   * - `ts` … 元のTS
   * - `encoded` … 主のエンコード済み (両方エンコードしたときは AV1)
   * - `alt` … もう一方 (H.264)。両方エンコードした録画でだけ在る。古いテレビはこちら
   *
   * アプリは録画の一覧 (`api/recordings`) の `files` から再生できるものを選んで名指しする。
   * 端末に保存も `encoded` / `alt` を名指しする (`offline-db.ts` の `downloadRequests`)。
   * 名指しが無ければ上の「今いいほう」
   */
  const path =
    source === "ts"
      ? recording.ts_path
      : source === "alt"
        ? recording.alt_path
        : source === "encoded"
          ? recording.library_path
          : encoding && recording.ts_path !== null
            ? recording.ts_path
            : (recording.library_path ?? recording.ts_path);
  if (path === null) error(404, "ファイルがありません");
  if (audio) return audioOnly(path, request);

  /*
   * 再生のためのエンドポイントなので、添付 (`Content-Disposition: attachment`) にはしない。
   * 録画をファイルとして持ち出すダウンロードは持たない (Discussion #760)
   */
  return serveFile(
    path,
    path.endsWith(".mkv") ? "video/x-matroska" : "video/mp2t",
    request,
  );
}

// HEAD も同じ処理 (中身を出すかは serveFile が request.method で決める)
export function GET({ params, request, url }) {
  return respond(
    params.id,
    request,
    parseFileSource(url.searchParams.get("source")),
    url.searchParams.get("audio") === "only",
  );
}
export const HEAD = GET;
