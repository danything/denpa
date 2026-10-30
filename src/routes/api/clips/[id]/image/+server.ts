import { clipImage, clipOr404 } from "#lib/server/clips.js";

/** 切り抜きの画像 (AVIF) */
export function GET({ params }) {
  return clipImage(clipOr404(params.id).file, false);
}
