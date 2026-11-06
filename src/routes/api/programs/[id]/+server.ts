import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";

import { getContractWarning } from "#lib/server/contracts.js";
import { orm } from "#lib/server/db.js";
import { programs, services } from "#lib/server/schema.js";
import type { ProgramDetail } from "#lib/types.js";

/**
 * 番組の詳細。番組表のマス・一覧の行・テレビのアプリのライブの詳細から、開いた 1 件だけ取る。
 *
 * 一覧に最初から詰めて返すと、出演者やあらすじが 300 件ぶん載って重くなる。
 * 開いた 1 件だけ取りに来てもらう。
 *
 * EPG は古い番組を消していくので、録画からは引けないことがある。
 * その場合は 404 を返し、画面は録画が持っている分だけを出す。
 */
export function GET({ params }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) error(400, "番組 ID が不正です");

  const row = orm()
    .select({
      service_id: programs.service_id,
      name: programs.name,
      description: programs.description,
      extended: programs.extended,
      genre_detail: programs.genre_detail,
      audios: programs.audios,
      video_type: programs.video_type,
      video_resolution: programs.video_resolution,
      is_free: programs.is_free,
      copy_never: programs.copy_never,
      series_episode: programs.series_episode,
      series_last_episode: programs.series_last_episode,
      series_repeat: programs.series_repeat,
      start_at: programs.start_at,
      end_at: programs.end_at,
      service_name: services.name,
    })
    .from(programs)
    .innerJoin(services, eq(services.id, programs.service_id))
    .where(eq(programs.id, id))
    .get();
  if (row === undefined) error(404, "番組が見つかりません");

  const program: ProgramDetail = {
    ...row,
    contract_warning: getContractWarning(row.service_id, row.is_free),
  };

  return json(program);
}
