import { error, json } from "@sveltejs/kit";

import { parseId } from "#lib/id.js";
import { recordAiring, recordedBody } from "#lib/server/reservations.js";

/**
 * **いま流れている番組を録る** (画面の外のもの向けの API。docs/api.md)。
 *
 * テレビのアプリの「録画」ボタン。画面のライブの録画ボタン (`live?/record`) と同じ処理
 * (`recordAiring`) で、予約は番組ごとに 1 本なので何度押しても二重には録らない。
 * 番組表にいまの番組が無ければ 404、予約できなければ 400 (どちらも `message` に理由)
 */
export async function POST({ params }) {
  const serviceId = parseId(params.serviceId);
  if (serviceId === null) error(400, "局 ID が不正です");

  const result = await recordAiring(serviceId);
  if (!result.ok) error(result.status, result.message);
  return json(recordedBody(result));
}
