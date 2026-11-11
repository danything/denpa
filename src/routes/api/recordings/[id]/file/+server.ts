import { error } from "@sveltejs/kit";

import { activeEncodeJob } from "#lib/server/encoder.js";
import { encodedFile } from "#lib/server/library.js";
import { fileAudioBody } from "#lib/server/playback.js";
import { recordingOr404 } from "#lib/server/recording.js";
import { serveFile } from "#lib/server/serve.js";
import {
  type FileSource,
  parseFileSource,
  recordedTransport,
  tsPathOf,
} from "#lib/source.js";

/** **音声だけ** (`?audio=only`。中身は `playback.fileAudioBody`) */
function audioOnly(path: string, request: Request): Response {
  const headers = { "Content-Type": "audio/aac", "Cache-Control": "no-store" };
  // HEAD はヘッダーだけ答える。再エンコードを起こさない
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(fileAudioBody(path), { headers });
}

/**
 * 録画ファイルをそのまま配る。
 * 観る側 (ブラウザ・テレビのアプリ) が URL を直に開いて再生するためのエンドポイント。
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
   * 基本はエンコード済み、無ければ元の TS。ただし**エンコードを待っている間・走っている間は
   * 元の TS のほう**を配る。再エンコードを待っている間は library_path がまだ古いファイルを
   * 指していて、しかもその古いファイルは走り出すときに消える (`encoder.runJob`) ので、
   * 押した瞬間によって出るものが変わっていた
   */
  const encoding = activeEncodeJob(recording.id) !== undefined;
  /*
   * **どれを寄越すか、名指しもできる** (`?source=ts` / `encoded` / `hevc` / `alt`)。
   *
   * - `ts` … 元の TS
   * - `encoded` … 主のエンコード済み (AV1 → H.265 → H.264 の先頭)
   * - `hevc` … H.265。AV1 と一緒にエンコードした録画でだけ在る (H.265 が主なら `encoded`)
   * - `alt` … H.264。ほかのコーデックと一緒にエンコードした録画でだけ在る。古いテレビはこちら
   *
   * アプリは録画の一覧 (`api/recordings`) の `files` から再生できるものを選んで名指しする。
   * 端末に保存も `encoded` / `hevc` / `alt` を名指しする (`offline-db.ts` の `downloadRequests`)。
   * 名指しが無ければ上の「今いいほう」
   */
  const path =
    source === "ts"
      ? recording.ts_path
      : source === "alt"
        ? recording.alt_path
        : source === "hevc"
          ? recording.hevc_path
          : source === "encoded"
            ? recording.library_path
            : encoding && recording.ts_path !== null
              ? recording.ts_path
              : // 置き場から消えたエンコード済みは選ばない (`encodedFiles`。観る画面と同じ判定)
                (encodedFile(recording) ?? tsPathOf(recording));
  if (path === null) error(404, "ファイルがありません");
  if (audio) return audioOnly(path, request);

  /*
   * 再生のためのエンドポイントなので、添付 (`Content-Disposition: attachment`) にはしない。
   * 録画をファイルとして持ち出すダウンロードは持たない (Discussion #760)
   */
  return serveFile(
    path,
    path.endsWith(".mkv")
      ? "video/x-matroska"
      : // 4K の局の元の録画 (`.mmts`) は 1 局に絞った TLV (ライブの 4K の局の `codec=raw` と同じ)
        recordedTransport(path) === "tlv"
        ? "application/x-arib-tlv"
        : "video/mp2t",
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
