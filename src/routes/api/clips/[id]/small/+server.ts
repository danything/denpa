import { clipImage, clipOr404 } from "#lib/server/clips.js";

/** 切り抜きの一覧用の画像 (AVIF。幅 480) */
export function GET({ params }) {
  return clipImage(clipOr404(params.id).file, true);
}
