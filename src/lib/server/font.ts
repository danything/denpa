/**
 * Denpa Font をどれだけ持たせるか (`/api/font/denpa-font.woff2`)。
 *
 * 画面はバージョン付きの URL (`?v=v2.1`。`#lib/font.ts`) で取りに来る。**入っている字とバージョンが
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
