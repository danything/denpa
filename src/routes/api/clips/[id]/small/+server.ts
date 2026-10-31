import { clipImage, clipOr404 } from "#lib/server/clips.js";

/** 切り抜きの一覧用の画像 (AVIF。幅 480)。`?v=` は `/image` と同じ */
export function GET({ params, url }) {
  return clipImage(clipOr404(params.id), true, url.searchParams.get("v"));
}
