/**
 * Denpa Font (放送の字。`/api/font/denpa-font.woff2`) の置き場。**URL はここだけで作る。**
 *
 * **版を付けて、1年持たせる。** 版は Dockerfile の `DENPA_FONT_VERSION`
 * (組むときに `vite.config.ts` が読んで埋める)。字が変わるのはリリースを上げたときだけで、
 * そのとき URL も変わるので、古い字が残らない。版の合わない問い合わせは配る側が
 * 毎回確かめさせる (`api/font/denpa-font.woff2/+server.ts`)
 */

import { resolve } from '$app/paths';

/** 組んだときの Denpa Font の版 (`v2.1` など)。読めなければ空 (版なしの URL になる) */
export const DENPA_FONT_VERSION: string = import.meta.env.DENPA_FONT_VERSION ?? '';

/** 字の URL。接頭辞の下でも動くよう、呼ぶたびに `resolve` を通す */
export function denpaFontUrl(): string {
    const url = resolve('api/font/denpa-font.woff2');
    return DENPA_FONT_VERSION === '' ? url : `${url}?v=${encodeURIComponent(DENPA_FONT_VERSION)}`;
}
