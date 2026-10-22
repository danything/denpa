import { error } from "@sveltejs/kit";
import { parseCaptionLanguage } from "#lib/caption-text.js";
import { recordingCaptions } from "#lib/server/live.js";

/**
 * **録画の字幕をアプリへ流す** (docs/api.md)。元のTS (`chase?codec=raw` と `file?source=ts`) を
 * 観ているアプリが、字幕を放送の PTS のまま受け取って映像に重ねる。`?from=<秒>` は映像を
 * リクエストした位置と同じもの (シークしたらリクエストし直す)。`?language=<1〜8>` で字幕の第何言語かを選ぶ
 * (省けば第1言語)。読み方は `live.ts` の `recordingCaptions`
 */
export function GET({ params, url }) {
  const id = Number(params.id);
  if (!Number.isInteger(id)) error(400, "録画IDが不正です");
  const from = Number(url.searchParams.get("from") ?? 0);
  const language = parseCaptionLanguage(url.searchParams.get("language"));
  const stream = recordingCaptions(
    id,
    Number.isFinite(from) ? Math.max(0, from) : 0,
    language,
  );
  if (stream === null) error(404, "録画がないか、元のTSがありません");
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
