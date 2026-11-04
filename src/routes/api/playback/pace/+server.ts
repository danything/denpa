import { error, json } from "@sveltejs/kit";

import { readPace } from "#lib/server/pace.js";

/**
 * **録画を流している応答の、送り出しの具合** (docs/api.md)。`?id=` は `stream` の応答ヘッダ `X-Denpa-Pace` の値。
 * 中身は `#lib/rungs.ts` の `Pace` で、エンコードの速さ (`speed`) を見て、回線が細いのかサーバのエンコードが遅いのかを読み分ける。
 * 閉じた応答・知らない id は 404
 */
export function GET({ url }) {
  const pace = readPace(url.searchParams.get("id") ?? "");
  if (pace === null) error(404, "この id で流しているものはありません");
  return json(pace, { headers: { "Cache-Control": "no-store" } });
}
