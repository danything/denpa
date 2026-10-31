import { clipImage, clipOr404 } from "#lib/server/clips.js";

/** 切り抜きの画像 (AVIF)。`?v=` は重ねのバージョン (`clipVersion`。合っていれば端末に持たせる) */
export function GET({ params, url }) {
  return clipImage(clipOr404(params.id), false, url.searchParams.get("v"));
}
