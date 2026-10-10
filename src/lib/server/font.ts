/**
 * Denpa Font をどれだけ持たせるか (`/api/font/denpa-font.woff2`)。
 *
 * 画面は版付きの URL (`?v=v2.1`。`#lib/font.ts`) で取りに来る。**入っている字と版が
 * 合うときだけ1年持たせる** (`immutable`)。字が変わるのはリリースを上げたときだけで、
 * そのとき URL も変わる。
 *
 * 合わない (版なし・古い画面・版を書いた札が無い) ときは**毎回確かめさせる**
 * (`no-cache` + ETag)。版の付かない URL を長く持たせると、イメージを入れ替えても
 * 古い字が残る (前に一度そうなった)
 */

/** 版が合ったときの持たせ方 */
export const FONT_IMMUTABLE = 'public, max-age=31536000, immutable';

/** `asked` は URL の `v`、`installed` はイメージに入っている版 (Dockerfile が書く札) */
export function fontCacheControl(asked: string | null, installed: string | null): string {
    return asked !== null && asked !== '' && asked === installed ? FONT_IMMUTABLE : 'no-cache';
}
