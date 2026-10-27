import { networks } from "./address";
import { config } from "./config";

/**
 * ホーム画面に置いたときの見た目 (PWA のマニフェスト)。
 *
 * **名前を来た名前ごとに変えられるようにしてある。** 同じ denpa を外向き
 * (`dp.doany.io`) と LAN 用 (`dp.l.doany.io`) の2つの名前で出していて、
 * 両方をホーム画面に置くと**アイコンも名前も同じものが2つ並ぶ**。
 * どちらを押せば家の中から繋がるほうなのか分からない。
 *
 * ブラウザは入れた時点のマニフェストを覚えるので、**入れ直すまで名前は
 * 変わりません** (Chrome は開き直したときに読み直して更新することがある)。
 */

/** 既定の名前。`PWA_NAMES` に載っていない名前で来たらこれ */
const DEFAULT_NAME = "denpa";

/**
 * この名前で来たときの表示名。
 *
 * 書き方は `ホスト名=表示名` のカンマ区切り (`PWA_NAMES`)。
 * 大文字小文字は問わない。載っていなければ `denpa`。
 */
export function appName(hostname: string): string {
  const target = hostname.toLowerCase();
  return (
    pwaNames().find((entry) => entry.host === target && entry.name !== "")
      ?.name ?? DEFAULT_NAME
  );
}

/** `PWA_NAMES` を読む。ホスト名は小文字にする。`=` の無いものは書き間違いとして飛ばす (表示名にも、知っている名前にもしない) */
export function pwaNames(): { host: string; name: string }[] {
  return networks(config.pwaNames).flatMap((raw) => {
    const at = raw.indexOf("=");
    if (at < 0) return [];
    return [
      {
        host: raw.slice(0, at).trim().toLowerCase(),
        name: raw.slice(at + 1).trim(),
      },
    ];
  });
}

/**
 * テーマの地の色 (app.css の `--dp-bg`)。`background_color` と `theme_color` に入れる。
 *
 * **Android でホーム画面から開くと、下のジェスチャーバーの帯は `background_color` で塗られる**
 * (ページはその帯の裏まで描けない。Chrome 155 で確かめた)。ダークの色のままだと、ライトで開いても
 * 帯だけ黒くなるので、ページの今のテーマで返す (`app.html` と `theme.svelte.ts` が `?theme=light` を付ける)。
 * Chrome は入れたあとのマニフェストを日を置いて読み直すので、テーマを替えても帯が追いつくのは後になる
 */
const BACKGROUND = { dark: "#0b0c0f", light: "#ffffff" } as const;

export type ManifestTheme = keyof typeof BACKGROUND;

export function manifest(
  hostname: string,
  theme: ManifestTheme = "dark",
): unknown {
  const name = appName(hostname);
  return {
    name,
    short_name: name,
    description: "テレビを録って観るためのもの",
    lang: "ja",
    /*
     * **`id` も名前ごとに分ける。** 既定は `start_url` なので、
     * どちらの名前で入れても同じ `/` になる。同じ端末に2つ置いたときに
     * 片方がもう片方の入れ直しとして扱われないよう、明示しておく
     */
    // URL は manifest の置き場からの相対。前段の接頭辞の下でも、その中を指す (server/paths.ts)。
    // 根で動かしていれば前と同じ `/?host=…` に解決されるので、入れてある PWA は別物にならない
    id: `./?host=${hostname.toLowerCase()}`,
    start_url: "./",
    scope: "./",
    display: "standalone",
    background_color: BACKGROUND[theme],
    theme_color: BACKGROUND[theme],
    icons: [
      { src: "./icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "./icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "./icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
      { src: "./icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
    shortcuts: [
      { name: "番組表", url: "./guide" },
      { name: "録画", url: "./" },
    ],
  };
}
