import { rememberResume } from './offline.svelte';

/**
 * どこまで観たかをサーバへ (`POST /api/recordings/<id>/resume`)。
 * **観る画面と追っかけで同じ扱いにする** — 別々に書いていた頃は、
 * 追っかけに `sendBeacon` もオフラインの控えも無く、閉じ際の位置が落ちえた。
 *
 * - 出ていく間際 (`leaving`) は `sendBeacon` で投げる。画面を畳んだあとの
 *   `fetch` はブラウザに捨てられることがあり、**最後に観たところがいちばん要る**
 * - 届かなければ端末に覚えて、オンライン復帰時にまとめて送る
 *   (`offline.svelte.ts` の resume の控え)
 */
export function keepResume(id: number, at: number, length: number, leaving = false): void {
    const body = JSON.stringify({ at, length });
    const url = `/api/recordings/${id}/resume`;
    if (leaving && navigator.sendBeacon !== undefined) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
    }
    void fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
    }).catch(() => {
        // オフラインで観ている。位置は端末に覚えて、復帰時にまとめて送る
        void rememberResume(id, at, length);
    });
}
