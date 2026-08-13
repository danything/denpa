/**
 * オフライン視聴の画面側 ([docs/offline.md](../../docs/offline.md))。
 *
 * 実体は IndexedDB (`offline-db.ts`)。ここはその**反応する影** — どの録画が
 * 端末に入っているかを一覧と視聴画面に映し、落とす・消す・サーバへ伝える
 * (outbox) の入口になる。
 *
 * ダウンロードは **Background Fetch** (ブラウザに預ける。タブを閉じても続く)。
 * 対応していないブラウザ (Safari/Firefox) はページ主導の fetch に落ちる —
 * タブを開いたままにしてもらう。
 */

import { browser } from '$app/environment';
import { downloadRequests, fetchId, type OfflineVideo, outbox, resumeQueue, videos } from './offline-db';

/** 画面に映すぶんだけ。blob はここに持たない (要るときに IndexedDB から) */
export interface OfflineEntry {
    id: number;
    state: 'downloading' | 'ready';
    source: 'encoded' | 'alt';
}

let entries = $state<Record<number, OfflineEntry>>({});
/** サーバからも消すと決めたもの (outbox)。一覧で「消える予定」と出す */
let pendingDelete = $state<Record<number, boolean>>({});
let started = false;

export const offline = {
    /** その録画は端末に入っているか (運んでいる最中も返す) */
    get entries(): Record<number, OfflineEntry> {
        return entries;
    },
    get pendingDelete(): Record<number, boolean> {
        return pendingDelete;
    },
    /** この端末で使えるか。IndexedDB と SW があれば、落とし方はどちらかで賄える */
    get usable(): boolean {
        return browser && 'indexedDB' in globalThis && 'serviceWorker' in navigator;
    },
};

async function refresh(): Promise<void> {
    const all = await videos.all();
    const next: Record<number, OfflineEntry> = {};
    for (const v of all) next[v.id] = { id: v.id, state: v.state, source: v.source };
    entries = next;

    const queued: Record<number, boolean> = {};
    for (const item of await outbox.all()) queued[item.id] = true;
    pendingDelete = queued;
}

/**
 * 起動時に1回。控えを読み、オンラインに戻る合図で outbox を流す。
 * SW からの「保存できた/失敗した」も受けて一覧を映し直す
 */
export function startOffline(): void {
    if (started || !offline.usable) return;
    started = true;

    void refresh();
    window.addEventListener('online', () => void flush());
    navigator.serviceWorker.addEventListener('message', (event) => {
        const type = (event.data as { type?: string } | null)?.type;
        if (type === 'offline-saved' || type === 'offline-failed') void refresh();
    });
    if (navigator.onLine) void flush();
}

/** 端末が AV1 を解けるか。解けなければ H.264 (`alt`) を落とす */
async function canPlayAv1(): Promise<boolean> {
    try {
        const info = await navigator.mediaCapabilities.decodingInfo({
            type: 'file',
            video: {
                contentType: 'video/mp4; codecs="av01.0.08M.08"',
                width: 1920,
                height: 1080,
                bitrate: 4_000_000,
                framerate: 60,
            },
        });
        return info.supported;
    } catch {
        return document.createElement('video').canPlayType('video/mp4; codecs="av01.0.08M.08"') !== '';
    }
}

/** 保存に使ってよい残り容量か。動画そのもの + 一時領域ぶんの遊びを見る */
async function ensureRoom(bytes: number): Promise<void> {
    try {
        const { usage, quota } = await navigator.storage.estimate();
        if (quota !== undefined && usage !== undefined && quota - usage < bytes * 1.2) {
            throw new Error(`端末の空きが足りません (あと ${Math.round((quota - usage) / 1e6)}MB)`);
        }
    } catch (error) {
        if (error instanceof Error && error.message.startsWith('端末の空き')) throw error;
        // 測れないブラウザでは黙って進む (入らなければ落とすところで転ぶ)
    }
    // ブラウザの都合で勝手に消されないように頼む。断られても致命ではない
    await navigator.storage.persist?.().catch(() => {});
}

export interface SaveTarget {
    id: number;
    name: string;
    service_name: string;
    start_at: number;
    duration_ms: number | null;
    ts_size: number;
    alt_path: string | null;
}

/**
 * 端末に保存する。**どちらを落とすかはここで決める** — 既定は AV1、
 * 端末が解けなければ H.264 (両方焼いた録画だけ)。
 */
export async function saveOffline(rec: SaveTarget): Promise<void> {
    let source: 'encoded' | 'alt' = 'encoded';
    if (!(await canPlayAv1())) {
        if (rec.alt_path === null) throw new Error('この端末は AV1 を再生できず、H.264 版もありません');
        source = 'alt';
    }
    await ensureRoom(rec.ts_size);

    const held: OfflineVideo = {
        id: rec.id,
        name: rec.name,
        serviceName: rec.service_name,
        startAt: rec.start_at,
        durationMs: rec.duration_ms,
        source,
        state: 'downloading',
        downloadedAt: Date.now(),
    };
    await videos.put(held);
    entries = { ...entries, [rec.id]: { id: rec.id, state: 'downloading', source } };

    const requests = downloadRequests(rec.id, source);
    try {
        const reg = await navigator.serviceWorker.ready;
        if (reg.backgroundFetch !== undefined) {
            // ブラウザに預ける。受け取りは SW (service-worker.ts)
            await reg.backgroundFetch.fetch(fetchId(rec.id, source), requests, {
                title: `denpa: ${rec.name}`,
                downloadTotal: rec.ts_size > 0 ? Math.round(rec.ts_size * 1.05) : undefined,
            });
            return;
        }
        // 対応していないブラウザ。タブを開いたまま、ページで落とす
        await downloadInPage(held, requests);
    } catch (error) {
        await videos.remove(rec.id);
        await refresh();
        throw error;
    }
}

/** ページ主導のフォールバック。SW の受け取りと同じ仕分けをこちらでやる */
async function downloadInPage(held: OfflineVideo, requests: string[]): Promise<void> {
    for (const url of requests) {
        const response = await fetch(url).catch(() => null);
        if (response === null || !response.ok) {
            if (url.includes('/file?')) throw new Error('動画を取得できませんでした');
            continue; // 付き添いは無い録画もある
        }
        if (url.includes('/file?')) held.video = await response.blob();
        else if (url.includes('captions.sup')) held.captions = await response.blob();
        else if (url.includes('poster')) held.poster = await response.blob();
        else if (url.includes('chapters')) held.chapters = await response.json().catch(() => undefined);
        else held.databroadcast = await response.json().catch(() => undefined);
    }
    held.state = 'ready';
    held.downloadedAt = Date.now();
    await videos.put(held);
    await refresh();
}

/** 端末から消して、**次にオンラインへ戻ったときサーバからも消す** (outbox) */
export async function removeEverywhere(rec: { id: number; name: string }): Promise<void> {
    await videos.remove(rec.id);
    await outbox.put({ id: rec.id, op: 'delete', name: rec.name, queuedAt: Date.now() });
    await refresh();
    if (navigator.onLine) await flush();
}

/** 端末からだけ消す (サーバの録画は残す)。保存し直したいときや空けたいとき用 */
export async function removeLocal(id: number): Promise<void> {
    // 運んでいる最中なら、ブラウザに預けたぶんも取り消す
    try {
        const reg = await navigator.serviceWorker.ready;
        for (const source of ['encoded', 'alt'] as const) {
            const running = await reg.backgroundFetch?.get(fetchId(id, source));
            await running?.abort();
        }
    } catch {
        // 預けていなければ何もない
    }
    await videos.remove(id);
    await refresh();
}

/** 観るとき用。実体を IndexedDB から出す (無ければ null) */
export async function loadOffline(id: number): Promise<OfflineVideo | null> {
    const held = await videos.get(id);
    return held !== undefined && held.state === 'ready' ? held : null;
}

/** オフライン中に進んだ視聴位置を覚えておく。復帰時に flush がまとめて送る */
export async function rememberResume(id: number, at: number, length: number): Promise<void> {
    await resumeQueue.put({ id, at, length, updatedAt: Date.now() });
}

/**
 * オンラインに戻ったらサーバへ伝える。
 * 削除は `DELETE /api/recordings/<id>`、視聴位置は `POST …/resume`。
 * 404 は「もう無い」なので済んだことにする。他の失敗は残して次の復帰で再試行
 */
export async function flush(): Promise<void> {
    for (const item of await outbox.all()) {
        try {
            const res = await fetch(`/api/recordings/${item.id}`, { method: 'DELETE' });
            if (res.ok || res.status === 404) await outbox.remove(item.id);
        } catch {
            // まだ繋がっていない。次の online で
        }
    }
    for (const item of await resumeQueue.all()) {
        try {
            const res = await fetch(`/api/recordings/${item.id}/resume`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ at: item.at, length: item.length }),
            });
            if (res.ok || res.status === 404) await resumeQueue.remove(item.id);
        } catch {
            // 同上
        }
    }
    await refresh();
}
