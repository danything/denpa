import { readFileSync } from 'node:fs';
import adapter from '@sveltejs/adapter-bun';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';
import Icons from 'unplugin-icons/vite';
import { defineConfig } from 'vite';

/**
 * イメージに入れる Denpa Font の版 (Dockerfile の `ARG DENPA_FONT_VERSION`)。
 * 字の URL に付けて、版ごとに1年持たせる (`src/lib/font.ts`)。読めなければ空にして言う
 * (動きは毎回確かめる側に落ちるだけなので、黙っていると1年持たないことに気付けない)
 */
const denpaFontVersion = (() => {
    let found = '';
    try {
        found =
            readFileSync(new URL('./Dockerfile', import.meta.url), 'utf8').match(
                /^ARG DENPA_FONT_VERSION=(\S+)/m,
            )?.[1] ?? '';
    } catch {}
    if (found === '')
        console.warn('Dockerfile から DENPA_FONT_VERSION を読めません。字の URL に版が付きません');
    return found;
})();

export default defineConfig({
    define: {
        'import.meta.env.DENPA_FONT_VERSION': JSON.stringify(denpaFontVersion),
    },
    plugins: [
        /*
         * SvelteKit の設定もここに置く (3 から `svelte.config.*` は読まれない)。
         */
        sveltekit({
            preprocess: vitePreprocess(),
            /*
             * adapter-bun の出力を bun で動かす。サーバ側では bun:sqlite などの
             * bun 組み込みモジュールをそのまま使える。
             *
             * **入口は `server.js`。** adapter が立てる `Bun.serve` にライブ視聴の
             * WebSocket を足してから `build/index.js` を読む (理由はあちらに書いてある)。
             *
             * - `idleTimeout: 0` — 録画の配信や SSE を無反応で切らせない (WebSocket は server.js で別に決める)
             * - `precompress` — 静的ファイルの br / gz を組むときに作っておく (adapter-node では既定で作っていた)
             */
            adapter: adapter({ precompress: true, serverOptions: { idleTimeout: 0 } }),
            /*
             * **画面で動いてよいスクリプトを、自分の束と SvelteKit の起動だけに絞る**
             * (Content-Security-Policy。方針と、読み込み元を1つずつ洗った表は docs/architecture.md の
             * 「画面で動いてよいもの」)。
             *
             * いちばんの狙いは**放送が書いたスクリプトを本物の JS として動かさない**こと。
             * データ放送のエンジン (`src/lib/bml/`) は放送の `onclick` などを DOM に写さず自前の VM で
             * 動かすが、写し漏れがあっても本物の JS として動かないよう二重に止める。
             * `script-src` に `'unsafe-inline'` を入れず、`script-src-attr 'none'` で属性のハンドラを止める。`eval` 系も許さない (`'unsafe-eval'` を入れない)。
             *
             * **nonce にする (hash ではなく)。** 設定画面・チューナーの画面は load から
             * Promise を返して後から流している (SvelteKit のストリーミング) — 流れてくる
             * `<script>` は頭を送ったあとに組まれるので hash を頭に載せられず、hash では止まる
             */
            csp: {
                mode: 'nonce',
                directives: {
                    'default-src': ['self'],
                    // nonce は SvelteKit が足す。束 (`_app/`) と遅延読み込み (データ放送のエンジン) は 'self'
                    'script-src': ['self'],
                    'script-src-attr': ['none'],
                    /*
                     * スタイルはその場で書くものを許す。サーバで組んだ HTML の `style` 属性 (観る画面の
                     * 映像の箱など)、`+layout.svelte` の @font-face の `<style>`。データ放送のエンジンは
                     * `element.style` (CSSOM) で書くのでこれには頼らない。
                     * 止めたいのはスクリプトで、CSS からできるのは見た目と下の *-src の範囲の読み込みまで
                     */
                    'style-src': ['self', 'unsafe-inline'],
                    // データ放送の画像は blob: (JPEG・PNG・GIF を作り直したもの) と data: (DRCS の字)
                    'img-src': ['self', 'data:', 'blob:'],
                    'font-src': ['self', 'data:', 'blob:'],
                    // MSE と端末に落とした録画は blob:
                    'media-src': ['self', 'blob:'],
                    // fetch・SSE・ライブの WebSocket はみな自分 ('self' は同じ host の ws:/wss: も含む)
                    'connect-src': ['self'],
                    // 変換せずに観る経路の worker と PWA の ServiceWorker
                    'worker-src': ['self'],
                    'object-src': ['none'],
                    // Hybridcast のアプリを入れる iframe (/api/bml/hybridcast。中は sandbox で使い捨てのオリジン)
                    'frame-src': ['self'],
                    'base-uri': ['self'],
                    'form-action': ['self'],
                },
            },
        }),
        /*
         * **アイコンは組むときに SVG ごと埋め込む** (`~icons/lucide/play` が Svelte の
         * 部品になる)。家の LAN だけ・オフラインでも開くものなので、Iconify の API へ
         * 取りに行く形 (`@iconify/svelte` の既定) は使わない。形は `@iconify-json/*`
         * (開発時だけの依存) から読むので、束に入るのは使ったアイコンの `<svg>` だけ。
         *
         * `denpa` は Lucide に無い自前のアイコン (`src/lib/icons/*.svg`。データ放送の d)。
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
        // compose 上の Jellyfin はサービス名(`http://app:5173`)で開発サーバにアクセスする。
        // vite の Host チェックに引っかかるので開発時だけ外す(本番は adapter-bun で
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
    },
    optimizeDeps: {
        exclude: ['bun:sqlite'],
    },
});
