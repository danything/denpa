import { eq } from "drizzle-orm";

import {
  intersect,
  MISSING_MIN,
  missingVideo,
  totalLength,
} from "../ts/cm-decide";
import type { Recording, VideoLoss } from "../types";
import type { CmMaterial } from "./cm-material";
import { orm } from "./db";
import { tsHeadOf } from "./recording";
import { recordings } from "./schema";

/**
 * **録画の番組のうち、元の TS に映像が無かった長さを測る。** 材料は CM 検出で読んだコマの時刻 (`cm-material.ts`)。
 *
 * 録画の行には、途中で切れたことを示すものがほかに無い。選局が切れて取り直しても、エージェントから届くデータが
 * 途切れても、録り終えた時刻 (`finished_at`) は終了時刻のままで、エラーも残らない (本番の TBS の 30 分で、元の TS が
 * 2.2 GB しかなく、映像は 18 分 50 秒で止まっていた)。届いたバイト数は局と番組で大きく違うので、量からは決められない。
 *
 * - 測る範囲は、番組の時刻のうち録り始めてから録り終えるまで。マージンの所と、チューナーを譲った所 (`format.clipNote`) は入れない
 * - 映像が無かった所は、コマの時刻が `MISSING_MIN` 秒以上空いた所 (`ts/cm-decide.missingVideo`)。範囲の先頭から 1 コマ目まで、
 *   最後のコマから範囲の終わりまでも数える (入れ物の尺より手前で映像が止まった録画もある)
 * - 材料の時刻は、足すと入れ物の先頭からの秒になる (`offset`)。入れ物の先頭の放送時刻は `ts_head`
 *   (測れていなければ録り始める予定の時刻。`recording.tsHeadOf`)
 *
 * コマが 1 つも無い (映像の無い録画) か、範囲が空なら null
 */
export function measureVideoLoss(
  material: Pick<CmMaterial, "times" | "offset">,
  recording: Pick<
    Recording,
    | "ts_head"
    | "record_from"
    | "record_to"
    | "start_at"
    | "end_at"
    | "finished_at"
  >,
): VideoLoss | null {
  const { times, offset } = material;
  if (times.length === 0) return null;
  const from = Math.max(
    recording.start_at,
    recording.record_from ?? recording.start_at,
  );
  const to = Math.min(
    recording.end_at,
    recording.record_to ?? recording.end_at,
    recording.finished_at ?? recording.end_at,
  );
  if (to <= from) return null;
  // 範囲を材料の時刻に直す
  const head = tsHeadOf(recording);
  const start = (from - head) / 1000 - offset;
  const end = (to - head) / 1000 - offset;
  const window = [{ start, end }];
  const lost = intersect(
    missingVideo(
      times,
      Math.max(end, times[times.length - 1]!),
      Math.min(start, times[0]!),
    ),
    window,
  );
  return {
    span: round(end - start),
    lost: round(totalLength(lost)),
    tail: times[times.length - 1]! < end - MISSING_MIN,
  };
}

const round = (seconds: number) => Math.round(seconds * 10) / 10;

/**
 * 測って録画の行に書く。材料が無い (映像を読めなかった) ときは書かない (前に測った値を残す)。
 * 行は読み直す (`ts_head` はエンコードしている間に埋まることがある。`recorded-bml.ts`)
 */
export function saveVideoLoss(
  recordingId: number,
  material: Pick<CmMaterial, "times" | "offset"> | undefined | null,
): void {
  if (material === undefined || material === null) return;
  const row = orm()
    .select()
    .from(recordings)
    .where(eq(recordings.id, recordingId))
    .get();
  if (row === undefined) return;
  const loss = measureVideoLoss(material, row);
  if (loss === null) return;
  orm()
    .update(recordings)
    .set({ video_loss: loss })
    .where(eq(recordings.id, recordingId))
    .run();
}
