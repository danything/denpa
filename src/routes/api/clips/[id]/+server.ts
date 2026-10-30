import { json } from "@sveltejs/kit";

import { clipOr404, deleteClips } from "#lib/server/clips.js";
import { emit } from "#lib/server/events.js";

/** 1枚の情報 (`Clip`)。画像は `/image` (そのまま)・`/small` (一覧用) */
export function GET({ params }) {
  const { file: _, ...clip } = clipOr404(params.id);
  return json(clip);
}

/** 1枚消す。画像も一緒に。もう無ければ 404 */
export function DELETE({ params }) {
  const clip = clipOr404(params.id);
  deleteClips([clip.id]);
  emit("clips");
  return new Response(null, { status: 204 });
}
