import { dirname, resolve } from 'node:path';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';
import Icons from 'unplugin-icons/vite';
import { defineConfig, type Plugin } from 'vite';

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
    plugins: [
        cssWithoutSourceMaps(),
        /*
         * SvelteKit の設定もここに置く (3 から `svelte.config.*` は読まれない)。
         */
        sveltekit({
            preprocess: vitePreprocess(),
            /*
             * adapter-node の出力を `bun ./build/index.js` で動かす。bun 前提なので
             * サーバ側では bun:sqlite などの bun 組み込みモジュールをそのまま使える。
             *
             * **入口は `server.js`。** ライブ視聴の WebSocket だけ `Bun.serve` で
             * 受けて、それ以外をここの出力へ流している (理由はあちらに書いてある)。
             */
            adapter: adapter(),
        }),
        /*
         * **アイコンは組むときに SVG ごと埋め込む** (`~icons/lucide/play` が Svelte の
         * 部品になる)。家の LAN だけ・オフラインでも開くものなので、Iconify の API へ
         * 取りに行く形 (`@iconify/svelte` の既定) は使わない。形は `@iconify-json/*`
         * (開発時だけの依存) から読むので、束に入るのは使ったアイコンの `<svg>` だけ。
         *
         * `denpa` は Lucide に無い自前の形 (`src/lib/icons/*.svg`。データ放送の d)。
         * 理由は docs/player.md の「アイコン」
         */
        Icons({
            compiler: 'svelte',
            customCollections: {
                denpa: FileSystemIconLoader('./src/lib/icons'),
            },
        }),
    ],
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
