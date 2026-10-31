import { error } from "@sveltejs/kit";

import { CLIP_LAYERS, type ClipLayer } from "#lib/clips.js";
import { clipLayer, clipOr404 } from "#lib/server/clips.js";

/** 元の画像 (`frame`・`captions`・`comments`)。開いた1枚で画面が重ねる。替わらないので `?v=` は要らない */
export function GET({ params }) {
  const part = params.part;
  if (part !== "frame" && !(CLIP_LAYERS as readonly string[]).includes(part))
    error(404, "元の画像がありません");
  return clipLayer(clipOr404(params.id), part as "frame" | ClipLayer);
}
