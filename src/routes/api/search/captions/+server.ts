import { json } from "@sveltejs/kit";

import { searchCaptions, searchQuery } from "#lib/server/search.js";

/** 返す録画の数の既定と上限 */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * **録画の字幕で探す** (docs/api.md)。読み方は結果の画面 (`/search?q=`) の節「録画の字幕」と同じ (`search.searchCaptions`)。
 * 観る先は denpa の根からの相対 (`watch/12?at=812.0`。ほかの API と同じ)。観られない録画 (ファイルが無い・録画が失敗した) は null
 */
export function GET({ url }) {
  const q = searchQuery(url.searchParams.get("q"));
  const asked = Number(url.searchParams.get("limit"));
  const limit =
    Number.isInteger(asked) && asked > 0
      ? Math.min(asked, MAX_LIMIT)
      : DEFAULT_LIMIT;
  const found = searchCaptions(q, { limit });
  return json({
    q,
    pending: found.pending,
    short: found.short,
    total: found.total,
    more: found.more,
    rows: found.rows.map((r) => {
      const watch =
        !r.has_file || r.state === "failed" || r.finished_at === null
          ? null
          : `watch/${r.id}`;
      return {
        id: r.id,
        name: r.name,
        service_name: r.service_name,
        start_at: r.start_at,
        watch,
        hits_total: r.hits_total,
        hits: r.hits.map((hit) => ({
          at: hit.at,
          text: hit.text,
          marks: hit.marks,
          before: hit.before,
          after: hit.after,
          language: hit.language,
          watch: watch === null ? null : `${watch}?at=${hit.at.toFixed(1)}`,
        })),
      };
    }),
  });
}
