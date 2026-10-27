import { and, eq, inArray, ne, notInArray } from "drizzle-orm";

import type { Range } from "../ts/cm-decide";
import { repeatedRanges, shotsOf, type StoredShot } from "../ts/cm-repeat";
import type { CmMaterial } from "./cm-material";
import { orm } from "./db";
import { siblings } from "./logo-data";
import { cmShots, recordings } from "./schema";

/**
 * **ロゴの無かった場面のハッシュの置き場** (`cm_shots`)。照らし方は `ts/cm-repeat.ts`。
 *
 * - 書くのは材料の控えを書くとき (`cm-material-store.saveMaterial`)。ロゴが使えた録画の、ロゴの無かった場面だけ
 * - 照らす相手は**ほかの局の録画だけ** (同じ映像を流している局も同じ局とみる。`logo-data.siblings`)。
 *   同じ局の中の繰り返しは、局の枠の頭の映像やシリーズの提供の CM のこともあり、CM とも番組とも言えない
 * - 新しい録画から貯まる。貯まるまでは何も言わない (CM の点が足されないだけで、今までと同じに決まる)
 */

/** ロゴの区間と重なる割合がこれ以下の場面を「ロゴの無かった場面」とする */
const BARE_SHARE = 0.1;
/** 一度に書く行の数 (SQLite の引数の数の上限に当たらないように) */
const CHUNK = 500;

/** 材料のロゴの区間を秒に直す (`cm.decideFromMaterial` と同じ) */
function logoRanges(material: CmMaterial): Range[] {
  const { times, duration, logo } = material;
  if (logo === null) return [];
  const at = (frame: number) =>
    frame < times.length ? times[frame]! : duration;
  return logo.spans.map((s) => ({ start: at(s.start), end: at(s.end + 1) }));
}

function overlap(ranges: Range[], range: Range): number {
  let sum = 0;
  for (const r of ranges)
    sum += Math.max(
      0,
      Math.min(r.end, range.end) - Math.max(r.start, range.start),
    );
  return sum;
}

/** 録画のロゴの無かった場面を書く (前のものは差し替え)。縮めたコマかロゴが無ければ消すだけ */
export function saveShots(recordingId: number, material: CmMaterial): void {
  const { look } = material;
  const logo = logoRanges(material);
  const rows =
    look === null || material.logo === null
      ? []
      : shotsOf(look, material.times, material.duration)
          .filter(
            (shot) =>
              overlap(logo, shot) <= BARE_SHARE * (shot.end - shot.start),
          )
          .map((shot) => ({
            recording_id: recordingId,
            seq: shot.seq,
            hash_hi: shot.hi,
            hash_lo: shot.lo,
            length: shot.end - shot.start,
          }));
  orm().transaction((tx) => {
    tx.delete(cmShots).where(eq(cmShots.recording_id, recordingId)).run();
    for (let i = 0; i < rows.length; i += CHUNK)
      tx.insert(cmShots)
        .values(rows.slice(i, i + CHUNK))
        .run();
  });
}

/**
 * 材料の場面のうち、ほかの局の録画でもロゴ無しで流れた区間 (材料の物差しの秒)。
 * 照らせないとき (縮めたコマが無い・読めない) は空。**CM 検出は落とさない**
 */
export function repeatedFor(
  recordingId: number,
  serviceId: number,
  material: CmMaterial,
): Range[] {
  if (material.look === null) return [];
  try {
    const same = [serviceId, ...siblings(serviceId)];
    const others: StoredShot[] = orm()
      .select({
        recording: cmShots.recording_id,
        seq: cmShots.seq,
        hi: cmShots.hash_hi,
        lo: cmShots.hash_lo,
        length: cmShots.length,
      })
      .from(cmShots)
      .innerJoin(recordings, eq(recordings.id, cmShots.recording_id))
      .where(
        and(
          ne(cmShots.recording_id, recordingId),
          notInArray(recordings.service_id, same),
        ),
      )
      .all();
    return repeatedRanges(
      shotsOf(material.look, material.times, material.duration),
      others,
    );
  } catch (error) {
    console.warn(`[cm] よその局の録画と照らせませんでした: ${error}`);
    return [];
  }
}

/** 録画の場面を捨てる (材料の控えを捨てたとき) */
export function forgetShots(recordingIds: number[]): void {
  if (recordingIds.length > 0)
    orm()
      .delete(cmShots)
      .where(inArray(cmShots.recording_id, recordingIds))
      .run();
}
