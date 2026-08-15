import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

/**
 * 借りもの ([vendor/web-bml](src/lib/vendor/web-bml/README.md)) の中の
 * `import css from "../public/default.css"` を**文字列として**読む。
 *
 * BML は放送のスタイルシートを土台の上に重ねるので、向こうは既定の CSS を
 * **中身の文字列として**取り込んでいる (webpack の `asset/source`)。Vite は
 * `.css` を読むと画面に流し込んでしまうので、ここだけ横取りする。
 *
 * **借りものを書き換えないための細工。** `?raw` を付ければ済む話だが、
 * それは向こうのファイルに手を入れることになる
 */
function bmlCss(): Plugin {
    /*
     * **頭の `\0` は「これは本物のファイルではない」の印。** 付けずに
     * `.css` のまま返すと、Vite の CSS 係が横から拾って PostCSS に
     * 食わせてしまう (`Unknown word export` で転ぶ)
     */
    const MARK = '\0denpa:bml-css:';
    /**
     * **`.css` で終わらせない。** Vite の CSS 係は名前の末尾だけを見る。
     *
     * **`.js` で終わらせる。** Rolldown は名前の末尾で「何のファイルか」を
     * 決めていて、`.txt` にすると*テキスト*と見なし、こちらが返した JS を
     * **もう一度まるごと文字列に包む** (`export default "export default \"…\";"`)。
     * 中身が二重になっても JS としては通ってしまうので、組み上げでは気づかず、
     * **画面で「BML の既定の見た目が丸ごと効いていない」**という形で出る
     * (実機で、映像が拡大されて左上に貼り付いた)
     */
    const TAIL = '.js';
    return {
        name: 'denpa:bml-css',
        enforce: 'pre',
        resolveId(source, importer) {
            if (!source.endsWith('.css') || importer === undefined) return null;
            if (!importer.includes('/vendor/web-bml/')) return null;
            return MARK + resolve(dirname(importer), source) + TAIL;
        },
        load(id) {
            if (!id.startsWith(MARK)) return null;
            const path = id.slice(MARK.length, -TAIL.length);
            return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`;
        },
    };
}

/**
 * `css` (web-bml が BML の CSS を書き換えるのに使う) の source map 対応を、
 * ブラウザ向けの組み上げでは空にする。
 *
 * `css.stringify` は `sourcemap` オプションを渡したときだけ
 * `source-map-support` を `require` する遅延読み込みだが、束ねる側は静的に辿るので
 * `source-map-resolve` → `fs` / `path` / `url` までブラウザ向けに巻き込まれ、
 * 「externalized for browser compatibility」の警告が組むたびに6つ並んでいた。
 * web-bml は sourcemap を渡さない (`transpile_css.ts`) ので、中身は空でよい
 */
function cssWithoutSourceMaps(): Plugin {
    const TARGET = /[\\/]css[\\/]lib[\\/]stringify[\\/]source-map-support\.js$/;
    return {
        name: 'denpa:css-no-sourcemap',
        enforce: 'pre',
        resolveId(source, importer) {
            if (source !== './source-map-support' || importer === undefined) return null;
            if (!TARGET.test(resolve(dirname(importer), `${source}.js`))) return null;
            return '\0denpa:css-no-sourcemap';
        },
        load(id) {
            if (id !== '\0denpa:css-no-sourcemap') return null;
            return 'export default function () {}';
        },
    };
}

export default defineConfig({
    plugins: [bmlCss(), cssWithoutSourceMaps(), tailwindcss(), sveltekit()],
    server: {
        // compose 上の Jellyfin はサービス名(`http://app:5173`)で開発サーバを叩く。
        // vite の Host チェックに引っかかるので開発時だけ外す(本番は adapter-node で
        // 動かすため、この設定は使われない)
        allowedHosts: true,
    },
    // bun:sqlite などの bun 組み込みモジュールは bundle させずランタイム解決に回す
    // (vite が解決しようとして "failed to resolve" になるため)
    ssr: {
        external: ['bun:sqlite', 'bun:test'],
    },
    build: {
        rollupOptions: {
            external: [/^bun:/],
        },
        /*
         * 大きさの警告は 700kB から。データ放送 (web-bml のブラウザ本体 + JIS の表)
         * が1つで 650kB ほどあり、**開いたときだけ落ちてくる遅延読み込み**にしてある
         * (`DataBroadcast.svelte` の `import()`)。BML のインタプリタはこれ以上
         * 割れないので、既定の 500kB では組むたびに同じ警告が出るだけだった。
         * 初期表示に載るものが 500kB を超えたら、こちらは黙らないので気付ける
         */
        chunkSizeWarningLimit: 700,
    },
    optimizeDeps: {
        exclude: ['bun:sqlite'],
    },
});
