import { eq, inArray } from "drizzle-orm";

import {
  type CmMaterial,
  decodeMaterial,
  encodeMaterial,
  MATERIAL_VERSION,
} from "./cm-material";
import { now, orm } from "./db";
import { cmMaterials, recordings } from "./schema";

/** CM 検出の材料の控えの置き場 (`cm_materials`)。中身の形式は `cm-material.ts` */

/** 控えを書く (同じ録画のものは差し替え)。**書けなくても CM 検出は落とさない** */
export function saveMaterial(recordingId: number, material: CmMaterial): void {
  try {
    const data = Buffer.from(encodeMaterial(material));
    const row = {
      recording_id: recordingId,
      version: MATERIAL_VERSION,
      data,
      created_at: now(),
    };
    orm()
      .insert(cmMaterials)
      .values(row)
      .onConflictDoUpdate({ target: cmMaterials.recording_id, set: row })
      .run();
  } catch (error) {
    console.warn(`[cm] 材料の控えを書けませんでした: ${error}`);
  }
}

/** 控えを読む。無い・版が違う・壊れているなら null */
export function loadMaterial(recordingId: number): CmMaterial | null {
  const row = orm()
    .select({ version: cmMaterials.version, data: cmMaterials.data })
    .from(cmMaterials)
    .where(eq(cmMaterials.recording_id, recordingId))
    .get();
  if (row === undefined || row.version !== MATERIAL_VERSION) return null;
  return decodeMaterial(row.data);
}

/**
 * 局の録画の控えを捨てる。**覚えたロゴを捨てたとき** — 控えのロゴの区間は捨てた型で当てたものなので、
 * やり直すときは読み直して新しく覚えたロゴで当てる
 */
export function forgetMaterials(serviceIds: number[]): void {
  const ids = orm()
    .select({ id: recordings.id })
    .from(recordings)
    .where(inArray(recordings.service_id, serviceIds))
    .all()
    .map((row) => row.id);
  if (ids.length > 0)
    orm()
      .delete(cmMaterials)
      .where(inArray(cmMaterials.recording_id, ids))
      .run();
}
