/// <reference lib="webworker" />

/**
 * ホーム画面から開けるようにするための最小限のサービスワーカー
 * + オフライン視聴の受け取り係 ([docs/offline.md](../docs/offline.md))。
 *
 * 録画一覧も番組表も**サーバの今の状態**が要るので、中身はキャッシュしない。
 * 古い一覧を見せるくらいなら、繋がらないと分かるほうがまし。
 * ここで持つのはアプリの殻(JS/CSS/アイコン)と、オフラインの入口 (`/offline`) だけ。
 *
 * オフライン視聴で足すのは **Background Fetch の受け取り**だけ — ブラウザに
 * 預けたダウンロードが終わったら IndexedDB へ移す。配信のキャッシュはしない。
 */

import { kindOf, parseFetchId, videos } from '$lib/offline-db';
import { build, files, version } from '$service-worker';

const CACHE = `denpa-${version}`;
/** 殻だけ。ロゴやサムネイルのような「増えるもの」は入れない */
const SHELL = [...build, ...files.filter((file) => !file.endsWith('robots.txt'))];
/**
 * オフラインの入口。電波の無いところで開いたとき、どの画面への行き先も
 * これで受ける (下の fetch)。**殻と違って HTML なので、版が変わる**。
 * install のたびに取り直す
 */
const OFFLINE_PAGE = '/offline';

const worker = self as unknown as ServiceWorkerGlobalScope;

worker.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE).then(async (cache) => {
            await cache.addAll(SHELL);
            // 入口は無くても殻は使える。焼き立てのデプロイ直後などで取れなくても諦める
            await cache.add(OFFLINE_PAGE).catch(() => {});
        }),
    );
    void worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
    // 版が変われば古い殻は用済み
    event.waitUntil(
        caches
            .keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
            .then(() => worker.clients.claim()),
    );
});

worker.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== location.origin) return;
    /*
     * API は素通しする。録画の配信は数十GB、通知は繋ぎっぱなしの SSE で、
     * どちらもキャッシュに載せると壊れる
     */
    if (url.pathname.startsWith('/api/')) return;

    /*
     * 画面への移動は**サーバ優先、繋がらなければオフラインの入口**。
     * 一覧や番組表を古いまま見せない方針はそのままに、電波の無いところでは
     * 真っ白なエラーではなく、落としてある録画の一覧に落ちる
     */
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(async () => {
                const fallback = await caches.match(OFFLINE_PAGE);
                return fallback ?? Response.error();
            }),
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((hit) => {
            // 殻はキャッシュから。それ以外は毎回サーバに聞く
            return hit ?? fetch(request);
        }),
    );
});

/* ---------- オフライン視聴: Background Fetch の受け取り ---------- */

/** 画面へ「変わったよ」と伝える。開いていなければ何も起きない (次に開いたとき読む) */
async function tellClients(message: unknown): Promise<void> {
    for (const client of await worker.clients.matchAll()) client.postMessage(message);
}

/**
 * ブラウザが運び終えた。**結果を IndexedDB へ移して初めて「保存済み」になる。**
 * 動画以外の付き添いは無い録画もある (404)。取れたぶんだけ持つ
 */
worker.addEventListener('backgroundfetchsuccess', (event) => {
    const parsed = parseFetchId(event.registration.id);
    if (parsed === null) return;
    event.waitUntil(
        (async () => {
            const held = await videos.get(parsed.id);
            if (held === undefined) return; // 画面側の控えが無い (先に消された)

            for (const record of await event.registration.matchAll()) {
                const kind = kindOf(record.request.url);
                if (kind === null) continue;
                const response = await record.responseReady.catch(() => null);
                if (response === null || !response.ok) continue;
                if (kind === 'video') held.video = await response.blob();
                else if (kind === 'captions') held.captions = await response.blob();
                else if (kind === 'poster') held.poster = await response.blob();
                else if (kind === 'chapters') held.chapters = await response.json().catch(() => undefined);
                else held.databroadcast = await response.json().catch(() => undefined);
            }

            if (held.video === undefined) {
                // 肝心の動画が無いなら保存とは言えない。控えごと消す
                await videos.remove(parsed.id);
                await tellClients({ type: 'offline-failed', id: parsed.id });
                return;
            }
            held.state = 'ready';
            held.downloadedAt = Date.now();
            await videos.put(held);
            await event.updateUI?.({ title: `保存しました: ${held.name}` });
            await tellClients({ type: 'offline-saved', id: parsed.id });
        })(),
    );
});

/** 失敗と取り消しは同じ扱い — 途中まで運んだものは使えないので控えごと捨てる */
function drop(event: BackgroundFetchEvent): void {
    const parsed = parseFetchId(event.registration.id);
    if (parsed === null) return;
    event.waitUntil(
        (async () => {
            await videos.remove(parsed.id);
            await tellClients({ type: 'offline-failed', id: parsed.id });
        })(),
    );
}
worker.addEventListener('backgroundfetchfail', drop);
worker.addEventListener('backgroundfetchabort', drop);

/** ブラウザのダウンロード表示を押したら、保存済みの一覧を開く */
worker.addEventListener('backgroundfetchclick', (event) => {
    event.waitUntil(worker.clients.openWindow(OFFLINE_PAGE));
});
