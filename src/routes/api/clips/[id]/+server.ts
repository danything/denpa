import { error, json } from "@sveltejs/kit";

import { parseLayerPatch } from "#lib/clips.js";
import {
  ClipError,
  clipOr404,
  deleteClips,
  setClipLayers,
} from "#lib/server/clips.js";
import { emit } from "#lib/server/events.js";

/** 1枚の情報 (`Clip`)。画像は `/image` (そのまま)・`/small` (一覧用) */
export function GET({ params }) {
  const { file: _, ...clip } = clipOr404(params.id);
  return json(clip);
}

/**
 * 字幕・コメントを出し入れする。本文は `{ "captions": false }` のように変えたいものだけ (`parseLayerPatch`)。
 * 元の画像から重ね直して `Clip` を返す。持っていない重ねなら 400
 */
export async function PATCH({ params, request }) {
  const clip = clipOr404(params.id);
  const patch = parseLayerPatch(await request.json().catch(() => null));
  if (patch === null)
    error(400, "captions・comments を true か false で送ってください");
  try {
    const { file: _, ...changed } = await setClipLayers(clip.id, patch);
    emit("clips");
    return json(changed);
  } catch (thrown) {
    if (thrown instanceof ClipError) error(thrown.status, thrown.message);
    throw thrown;
  }
}

/** 1枚消す。画像も一緒に。もう無ければ 404 */
export function DELETE({ params }) {
  const clip = clipOr404(params.id);
  deleteClips([clip.id]);
  emit("clips");
  return new Response(null, { status: 204 });
}
