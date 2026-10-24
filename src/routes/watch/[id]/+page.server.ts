import { existsSync } from "node:fs";
import { error, fail, redirect } from "@sveltejs/kit";
import { eq, getTableColumns } from "drizzle-orm";
import { orm } from "#lib/server/db.js";
import { deleteRecordingFiles } from "#lib/server/files.js";
import { sidecarPaths } from "#lib/server/metadata.js";
import { relative } from "#lib/server/paths.js";
import { encodedPath, rulerOf, tsPathOf } from "#lib/server/playback.js";
import { recordingFromForm } from "#lib/server/recording.js";
import { lastEncodeError, recordings } from "#lib/server/schema.js";
import { settings } from "#lib/server/settings.js";
import { fromTsTime } from "#lib/ts/watch.js";
import type { Recording } from "#lib/types.js";

/**
 * 録画を観る画面。一覧のポップアップではなく1枚の画面にするのは、端末の「戻る」がそのまま効き、URL が残るため。
 * 何で観るかは開いてから決める (`api/recordings/<id>/playback`。`ts/playback.ts`)。録っている最中だけ追っかけ再生
 * (`/chase`) へ送り、エンコード済みも元の TS も無ければ「まだ観られません」と理由を出す
 */

interface WatchRow extends Recording {
  /** 直近のエンコード失敗の理由。エンコードできていない理由として出す */
  encode_error: string | null;
}

export function load({ params, url }) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) error(404, "録画が見つかりません");

  const recording: WatchRow | undefined = orm()
    .select({
      ...getTableColumns(recordings),
      encode_error: lastEncodeError(recordings.id),
    })
    .from(recordings)
    .where(eq(recordings.id, id))
    .get();
  if (recording === undefined) error(404, "録画が見つかりません");
  if (recording.deleted_at !== null) error(410, "この録画は削除されています");
  const encoded = encodedPath(recording);
  const ts = tsPathOf(recording);
  // 録っている最中は追っかけ再生へ (伸びている TS を追い読みする)
  if (encoded === null && ts !== null && recording.finished_at === null)
    redirect(302, relative(url, `/chase/${id}`));

  /*
   * データ放送を取り出してあるか (無い局・古い録画では出さない)。中身は d ボタンで別に取る。
   * **エンコード済みの時刻で書いてある**ので、まだエンコードしていない録画では出さない
   */
  const hasData =
    encoded !== null && existsSync(sidecarPaths(encoded).dataBroadcast);

  // 続きの位置は元の TS の物差しで覚えている。この画面の物差し (`playbackPlan` の `axis`) に直して渡す
  if (recording.resume_ms !== null) {
    recording.resume_ms = Math.round(
      fromTsTime(recording.resume_ms / 1000, rulerOf(recording, null)) * 1000,
    );
  }

  // 郵便番号と都道府県は、ライブと同じく受信機の設定としてエンジンに渡す (`DataBroadcast`)
  const { postalCode, prefecture } = settings();
  return {
    recording,
    /** 観るものがあるか。エンコード済みか、録り終えた元の TS */
    playable: encoded !== null || ts !== null,
    broadcast: { postalCode, prefecture },
    hasData,
  };
}

export const actions = {
  /** 観終わったその場で消す (末尾はたいてい CM なので、流したまま消せる。2回押させるのは一覧と同じ) */
  delete: async ({ request, url }) => {
    const form = await request.formData();
    const recording = recordingFromForm(form);
    if (recording === undefined)
      return fail(400, { message: "録画が見つかりません" });
    deleteRecordingFiles(recording, "手動削除");
    /*
     * 消したら一覧へ戻す。ここで返すと SvelteKit が `load` を回し直し、消えた録画に 410 を投げて
     * 観ていた画面がエラー画面に変わる
     */
    redirect(303, relative(url, "/"));
  },
};
