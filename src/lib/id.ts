/**
 * **行の ID を読む** (URL のパス・クエリ・フォームの値)。画面のアクションも API も、ID はこれで読む。
 *
 * 10 進の整数で、数として正しく扱える範囲 (`Number.isSafeInteger`) のものだけを返す。空・小数・指数 (`1e3`)・
 * 16 進 (`0x10`)・前後の空白・桁あふれは null。`Number()` だけで読むと、空は 0、`1e3` は 1000 になる。
 * 負の数は通す (取り込んだ録画の番組 ID は EPGStation の ID の符号を反転したもの。`migrate.ts`)
 */
export function parseId(value: unknown): number | null {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}
