import { eq } from "drizzle-orm";

import { parseClipQuery } from "#lib/clips.js";
import { clipFacets, findClips } from "#lib/server/clips.js";
import { orm } from "#lib/server/db.js";
import { recordings } from "#lib/server/schema.js";

/**
 * **切り抜き** の画面 (`/clips`)。条件は URL (`GET /api/clips` と同じ名前) で持ち、最初の 60 枚と
 * サイドバーの手がかり (撮った日・局ごとの枚数・使っている量) を渡す。続きは画面が API から足す
 */
export function load({ url }) {
  const query = parseClipQuery(url.searchParams);
  // 続き (`before`) は画面が API で足す。URL に残っていても頭から出す
  delete query.before;
  const { clips, next } = findClips(query);
  /** 録画で絞っているときは、その名前を出す (外す印に添える) */
  const recording =
    query.recording === undefined
      ? null
      : (orm()
          .select({ id: recordings.id, name: recordings.name })
          .from(recordings)
          .where(eq(recordings.id, query.recording))
          .get() ?? null);
  return { query, clips, next, facets: clipFacets(), recording };
}
