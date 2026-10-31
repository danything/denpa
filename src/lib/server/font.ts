/**
 * Denpa Font をどう配るか (`/api/font/` の woff2 の 2 つと、それを名乗らせる CSS)。
 *
 * 画面はバージョン付きの URL (`?v=v2.1`。`#lib/font.ts`。woff2 は CSS が付ける) で取りに来る。**入っている字とバージョンが
 * 合うときだけ1年持たせる** (`immutable`)。字が変わるのはリリースを上げたときだけで、
 * そのとき URL も変わる。
 *
 * 合わない (バージョンなし・古い画面・バージョンを書いた印が無い) ときは**毎回確かめさせる**
 * (`no-cache` + ETag)。バージョンの付かない URL を長く持たせると、イメージを入れ替えても
 * 古い字が残る (前に一度そうなった)
 */

/** バージョンが合ったときの持たせ方 */
export const FONT_IMMUTABLE = "public, max-age=31536000, immutable";

/** `asked` は URL の `v`、`installed` はイメージに入っているバージョン (Dockerfile が書く印) */
export function fontCacheControl(
  asked: string | null,
  installed: string | null,
): string {
  return asked !== null && asked !== "" && asked === installed
    ? FONT_IMMUTABLE
    : "no-cache";
}

/** 配るファイル → 中身の種類。woff2 はイメージの置き場 (Dockerfile の `denpa-font` 段) のまま、CSS はここで作る (`fontCss`) */
export const FONT_FILES = new Map<string, string>([
  ["denpa-font.woff2", "font/woff2"],
  ["denpa-font-jisx0213.woff2", "font/woff2"],
  ["denpa-font.css", "text/css; charset=utf-8"],
]);

/** CSS の unicode-range の値 (`U+4E02,U+4E04-4E05,…`)。リリースの `denpa-font-jisx0213.txt` を読むときに確かめる */
const RANGES =
  /^U\+[0-9A-F]{1,6}(-[0-9A-F]{1,6})?(,U\+[0-9A-F]{1,6}(-[0-9A-F]{1,6})?)*$/i;

/**
 * Denpa Font を名乗らせる CSS (`/api/font/denpa-font.css`)。**2 つの woff2 を同じファミリ名で名乗らせる**:
 * 基本の字 (`denpa-font.woff2`) と、JIS X 0213 で足された漢字 (`denpa-font-jisx0213.woff2`)。後のほうには
 * `unicode-range` を付けるので、ブラウザはその字が画面に出たときだけ取りに行く (多くの画面は基本の字だけで済む)。
 *
 * URL は CSS からの相対 (接頭辞の下でも同じ)。`version` は入っているバージョンで、woff2 を1年持たせる鍵。
 * 範囲 (`ranges`) が無い・読めないときは基本のファイルだけを名乗らせる
 */
export function fontCss(version: string, ranges: string | null): string {
  const v = version === "" ? "" : `?v=${encodeURIComponent(version)}`;
  const face = (file: string, more = "") =>
    `@font-face{font-family:"Denpa Font";src:url("${file}${v}") format("woff2");font-display:swap${more}}\n`;
  const range = ranges?.trim() ?? "";
  return (
    face("denpa-font.woff2") +
    (RANGES.test(range)
      ? face("denpa-font-jisx0213.woff2", `;unicode-range:${range}`)
      : "")
  );
}
