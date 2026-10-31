/**
 * Denpa Font (放送の字。`/api/font/`) の置き場。**URL はここだけで作る。**
 *
 * 字は 2 つの woff2 に分かれている (基本の字と、JIS X 0213 で足された漢字)。画面の字 (`app.css` の
 * `.broadcast`) と字幕は、2 つを `unicode-range` で名乗らせる CSS (`denpaFontCssUrl`) を読み、
 * 後のほうはその字が出たときだけ落ちてくる。データ放送は基本の字だけで足りる (`denpaFontUrl`)。
 *
 * **バージョンを付けて、1年持たせる。** バージョンは Dockerfile の `DENPA_FONT_VERSION`
 * (組むときに `vite.config.ts` が読んで埋める)。字が変わるのはリリースを上げたときだけで、
 * そのとき URL も変わるので、古い字が残らない。バージョンの合わない問い合わせは配る側が
 * 毎回確かめさせる (`api/font/[file]/+server.ts`)
 */

import { resolve } from "$app/paths";

/** 組んだときの Denpa Font のバージョン (`v3.6` など)。読めなければ空 (バージョンの付かない URL になる) */
const DENPA_FONT_VERSION: string = import.meta.env.DENPA_FONT_VERSION ?? "";

/** `/api/font/<file>` にバージョンを付けたもの。接頭辞の下でも動くよう、呼ぶたびに `resolve` を通す */
function versioned(file: "denpa-font.woff2" | "denpa-font.css"): string {
  const url = resolve(`api/font/${file}`);
  return DENPA_FONT_VERSION === ""
    ? url
    : `${url}?v=${encodeURIComponent(DENPA_FONT_VERSION)}`;
}

/** 基本の字の woff2 (データ放送。EUC-JP の字と追加記号だけを描くので、JIS X 0213 で足された漢字は要らない) */
export function denpaFontUrl(): string {
  return versioned("denpa-font.woff2");
}

/** 2 つの woff2 を `"Denpa Font"` の名前で名乗らせる CSS (画面の放送の字と字幕) */
export function denpaFontCssUrl(): string {
  return versioned("denpa-font.css");
}
