import { error, json } from "@sveltejs/kit";

import { guideOf, programRange } from "#lib/server/guide.js";
import { CHANNEL_TYPES } from "#lib/types.js";

/**
 * **外から使う番組表** (テレビのアプリの番組表。docs/api.md)。
 *
 * 画面の番組表のマス (`/api/guide`) と同じ `programsOf`・`stationsOf` から組むので、予約の状態はマスと食い違わない。
 * 種別は省かせない (どの種別の表かを呼ぶ側が決める)。範囲は `programRange` (省けば今日の放送日、24 時間まで)。
 * `subchannels=1` のときだけサブチャンネルの列も返す (ほかの値と省いたときは本チャンネルだけ)
 */
export function GET({ url }) {
  const type = CHANNEL_TYPES.find((t) => t === url.searchParams.get("type"));
  if (type === undefined) error(400, "type は GR・BS・CS のどれかです");
  const range = programRange(
    url.searchParams.get("from"),
    url.searchParams.get("to"),
  );
  if (range === null)
    error(400, "from と to は UNIX ミリ秒で、to は from より後にします");
  return json(
    guideOf(
      type,
      range.from,
      range.to,
      url.searchParams.get("subchannels") === "1",
    ),
  );
}
