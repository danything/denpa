import { error, json } from "@sveltejs/kit";

import { parseId } from "#lib/id.js";
import {
  cancelProgram,
  recordedBody,
  recordProgram,
} from "#lib/server/reservations.js";

/**
 * **番組表の番組を予約する・取り消す** (テレビのアプリの番組表。docs/api.md)。
 *
 * 予約は `POST /api/services/<id>/record` と同じ処理 (`reserve`)、取り消しは画面の番組表の
 * 「予約取消」と同じ処理 (`cancelProgram`)。エンドポイントごとに断り方がずれると、片方でだけ録れない番組が出る。
 * 番組 ID が整数でなければ 400
 */
export async function POST({ params }) {
  const result = await recordProgram(programId(params.id));
  if (!result.ok) error(result.status, result.message);
  return json(recordedBody(result));
}

/** 録画中なら止めて、そこまでの録画は残す。取り消していない予約が無ければ 404、録り終えたものは 409 */
export async function DELETE({ params }) {
  const result = await cancelProgram(programId(params.id));
  if (!result.ok) error(result.status, result.message);
  return json({ stopped: result.stopped });
}

function programId(raw: string): number {
  const id = parseId(raw);
  if (id === null) error(400, "番組 ID が不正です");
  return id;
}
