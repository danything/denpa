import { error } from "@sveltejs/kit";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";

import { parseId } from "../id";
import type { Recording } from "../types";
import { config } from "./config";
import { orm } from "./db";
import { recordings, reservations } from "./schema";
import type { Payload } from "./webhook";

/**
 * 通知 (webhook) に載せる録画の要点。録画とエンコードの節目で同じ形式。
 * webhook.ts に置かないのは、テストがそちらを差し替える (`disk.test.ts`) ため
 */
export function recordingSummary(
  recording: Recording,
): NonNullable<Payload["recording"]> {
  return {
    id: recording.id,
    name: recording.name,
    service: recording.service_name,
    startAt: recording.start_at,
    endAt: recording.end_at,
  };
}

/** フォームの `id` から録画を引く (画面のアクション用)。無ければ undefined。消した行も引く */
export function recordingFromForm(form: FormData): Recording | undefined {
  const id = parseId(form.get("id"));
  if (id === null) return undefined;
  return orm().select().from(recordings).where(eq(recordings.id, id)).get();
}

/**
 * `/api/recordings/<id>` 系の前置き。id を確かめて行を引く。
 * 数字でなければ 400、無ければ 404 をここで投げるので、呼ぶ側は
 * ある前提で書ける。
 *
 * @param deleted 消した行も引くか。**既定は引かない** (観る API が
 *   消したものを返さないように)。削除 API だけは「もう消えている」を
 *   見分けたいので true で呼ぶ
 */
export function recordingOr404(idLike: string, deleted = false): Recording {
  const id = parseId(idLike);
  if (id === null) error(400, "録画 ID が不正です");
  const recording = orm()
    .select()
    .from(recordings)
    .where(
      deleted
        ? eq(recordings.id, id)
        : and(eq(recordings.id, id), isNull(recordings.deleted_at)),
    )
    .get();
  if (recording === undefined) error(404, "録画が見つかりません");
  return recording;
}

/**
 * 録画の先頭の放送時刻 (`ts_head`) を書く。**空のときだけ**書く。録っている間に測れていれば、
 * エンコードのときに測り直した値で上書きしない (どちらも同じ TS の先頭を測るので同じ値になる)
 */
export function fillTsHead(recordingId: number, head: number): void {
  orm()
    .update(recordings)
    .set({ ts_head: head })
    .where(and(eq(recordings.id, recordingId), isNull(recordings.ts_head)))
    .run();
}

/**
 * **録り始める予定の時刻** (unix ms)。チューナーを譲って冒頭を削ったなら `record_from`、
 * そうでなければ番組の始まりの `START_MARGIN` 前。予約と録画の行のどちらにも使う
 * (録画の行は予約から `record_from` を写している。`recorder.ts`)
 */
export function plannedStart(
  row: Pick<Recording, "record_from" | "start_at">,
): number {
  return row.record_from ?? row.start_at - config.startMargin;
}

/** 予約の行の {@link plannedStart} を SQL で (始める予約を引くとき。`scheduler.ts`) */
export function plannedStartSql(): SQL<number> {
  return sql<number>`COALESCE(${reservations.record_from}, ${reservations.start_at} - ${config.startMargin})`;
}

/**
 * **元の TS の先頭 (再生位置 0 の手前) の放送時刻** (unix ms)。測った値 (`ts_head`) があればそれ、
 * 測れていない録画 (TDT を読めない・取り込んだ録画) は録り始める予定の時刻 (`plannedStart`) で
 * 代わりにする。数秒ずれることがある。実況のコメント (`jikkyo.ts`)、切り抜きの位置 (`clips.ts`)、
 * CM 検出で番組の始まりを見分けるところ (`encoder.programSpan`) が使う
 */
export function tsHeadOf(
  recording: Pick<Recording, "ts_head" | "record_from" | "start_at">,
): number {
  return recording.ts_head ?? plannedStart(recording);
}
