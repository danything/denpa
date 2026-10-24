/**
 * **最近の検索** (`/search` を言葉なしで開いたときに出す)。端末ごとに覚える (localStorage)。
 *
 * サーバには持たない — 同じアカウントを家族で使っていても、ほかの人が探したものは出さない。
 * 読めない・書けない (プライベートブラウズなど) ときは、覚えないだけで検索は使える
 */

import { forget, read, write } from "./keep";

const KEY = "denpa.recent-searches";
/** 覚えておく数。新しいものが先頭 */
export const RECENT_MAX = 8;

/** 足した並び。同じ言葉 (前後の空白を除いて) は先頭へ移す */
export function pushRecent(list: string[], q: string): string[] {
  const word = q.trim();
  if (word === "") return list;
  return [word, ...list.filter((item) => item !== word)].slice(0, RECENT_MAX);
}

/** 文字列から読む。形が違えば空 */
export function parseRecent(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is string =>
          typeof item === "string" && item.trim() !== "",
      )
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

export function loadRecent(): string[] {
  return parseRecent(read(KEY));
}

export function saveRecent(list: string[]): void {
  if (list.length === 0) forget(KEY);
  else write(KEY, JSON.stringify(list));
}
