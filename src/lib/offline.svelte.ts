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
import {
    downloadRequests,
    fetchId,
    fetchIdPrefix,
    type OfflineVideo,
    outbox,
    parseFetchId,
    resumeQueue,
    storeResponse,
    videos,
} from './offline-db';

/** 画面に映すぶんだけ。blob はここに持たない (要るときに IndexedDB から) */
export interface OfflineEntry {
    state: 'downloading' | 'ready' | 'failed';
    /** 落とせた割合 (0〜1)。測れない間は null (動いているだけのバーにする) */
    progress: number | null;
}

let entries = $state<Record<number, OfflineEntry>>({});
/** サーバからも消すと決めたもの (outbox)。一覧で「消える予定」と出す */
let pendingDelete = $state<Record<number, boolean>>({});
/** 保存に失敗した録画。画面が読んだら消す (`clearFailed`) — 黙って消えると分からない */
let failed = $state<number | null>(null);
/** 控えが変わるたびに増える。`/offline` の一覧はこれを見て読み直す */
let revision = $state(0);
let started = false;

export const offline = {
    /** その録画は端末に入っているか (運んでいる最中も返す) */
    get entries(): Record<number, OfflineEntry> {
        return entries;
    },
    get pendingDelete(): Record<number, boolean> {
        return pendingDelete;
    },
    /** 保存に失敗した録画のID。画面はこれを見て知らせを出す */
    get failed(): number | null {
        return failed;
    },
    /** 控えの読み直しの回数。一覧の映し直しの合図に使う */
    get revision(): number {
        return revision;
    },
    /** この端末で使えるか。IndexedDB と SW があれば、落とし方はどちらかで賄える */
    get usable(): boolean {
        return browser && 'indexedDB' in globalThis && 'serviceWorker' in navigator;
    },
};

export function clearFailed(): void {
    failed = null;
}

async function refresh(): Promise<void> {
    const all = await videos.all();
    const next: Record<number, OfflineEntry> = {};
    for (const v of all) {
        // 進み具合は IndexedDB に無い (watchProgress が訊きに行く)。読み直しで消さない
        next[v.id] = { state: v.state, progress: entries[v.id]?.progress ?? null };
    }
    entries = next;

    const queued: Record<number, boolean> = {};
    for (const item of await outbox.all()) queued[item.id] = true;
    pendingDelete = queued;
    revision += 1;
}

/** 進み具合を1件ぶん書き換える。無い行には書かない (先に消されたもの) */
function setProgress(id: number, progress: number | null): void {
    const held = entries[id];
    if (held === undefined) return;
    entries = { ...entries, [id]: { ...held, progress } };
}

/** 進み具合を見ている最中の録画。同じものを二重に見ない */
const polling = new Set<number>();

/**
 * ブラウザに預けたダウンロードの進み具合を映す。**イベントとポーリングの両建て。**
 *
 * `progress` イベントだけに任せると、**登録時に掴んだオブジェクトへの通知は
 * 途中で途切れることがある** — 遅い回線でブラウザがダウンロードを止めて
 * 再開すると、その後のイベントが届かず、割合が張り付いたままになっていた
 * (開き直すと取り直すので直る)。かといって訊きに行くだけでは、その間隔でしか
 * 数字が動かない。
 *
 * そこで **2秒おきに get() で新しく掴み直し、掴んだものに毎回 `progress` も
 * 付ける** — イベントが生きている間はコマ落ちなく動き、黙り込んだ個体は
 * 次の掴み直しが引き取る。終わったかどうかはここでは決めない — 成否は
 * SW の受け取りが伝えてくる
 */
function watchProgress(reg: BackgroundFetchRegistration, parsed = parseFetchId(reg.id)): void {
    if (parsed === null || polling.has(parsed.id)) return;
    polling.add(parsed.id);
    const id = parsed.id;

    void (async () => {
        try {
            const sw = await navigator.serviceWorker.ready;
            while (true) {
                const running = await sw.backgroundFetch?.get(reg.id);
                // 終わった (成功・失敗どちらでも登録は消える)。表示は SW の知らせが変える
                if (running === undefined || running.result !== '') return;
                const show = () =>
                    setProgress(
                        id,
                        running.downloadTotal > 0
                            ? Math.min(1, running.downloaded / running.downloadTotal)
                            : null,
                    );
                show();
                running.addEventListener('progress', show);
                try {
                    // 控えが消えた・状態が変わったなら見続ける理由が無い
                    if (entries[id]?.state !== 'downloading') return;
                    await new Promise((resolve) => setTimeout(resolve, 2000));
                } finally {
                    running.removeEventListener('progress', show);
                }
            }
        } finally {
            polling.delete(id);
        }
    })();
}

/**
 * 開き直したとき、運んでいる最中のものに追いつく (預けた側のタブはもう無いかもしれない)。
 *
 * **突き合わせもする。** 控えは「保存中」なのに、ブラウザ側に対応する
 * ダウンロードが無い — ページ主導のフォールバック中にタブを閉じた、
 * SW が受け取りそこねた — なら、それはもう動いていない。失敗に倒して
 * やり直す口にする (「保存中」のまま永遠に張り付かない)
 */
async function watchRunning(): Promise<void> {
    try {
        const reg = await navigator.serviceWorker.ready;
        if (reg.backgroundFetch === undefined) return;

        const alive = new Set<number>();
        for (const id of await reg.backgroundFetch.getIds()) {
            const running = await reg.backgroundFetch.get(id);
            if (running === undefined) continue;
            const parsed = parseFetchId(running.id);
            if (parsed === null) continue;
            watchProgress(running, parsed);
            alive.add(parsed.id);
        }

        for (const held of await videos.all()) {
            if (held.state !== 'downloading' || alive.has(held.id)) continue;
            held.state = 'failed';
            await videos.put(held);
        }
        await refresh();
    } catch {
        // 預けたものが無いだけ
    }
}

/**
 * 起動時に1回。控えを読み、オンラインに戻る合図で outbox を流す。
 * SW からの「保存できた/失敗した」も受けて一覧を映し直す
 */
export function startOffline(): void {
    if (started || !offline.usable) return;
    started = true;

    void refresh().then(() => watchRunning());
    window.addEventListener('online', () => void flush());
    navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data as { type?: string; id?: number } | null;
        if (data?.type === 'offline-saved' || data?.type === 'offline-failed') void refresh();
        // 失敗は黙って控えが消えるだけだと「無かったことになった」ように見える。画面に知らせる
        if (data?.type === 'offline-failed' && typeof data.id === 'number') failed = data.id;
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
            throw new Error(`端末の空きが足りません (空きは残り ${Math.round((quota - usage) / 1e6)}MB)`);
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
 * これから落とすものを HEAD で下見して、**在るものだけ**に絞り、実サイズを足す。
 *
 * どちらも Background Fetch の仕様が理由 (実機の Edge で踏んだ):
 *
 * - **404 が1つでも混ざると全体が失敗になる** (`failureReason: bad-status`)。
 *   付き添い (字幕・データ放送・ポスター) は無い録画もあるので、そのまま
 *   渡すと**動画は落ち終わっているのに**全部が捨てられる。進みは 97% あたりで
 *   止まり、控えごと消えて「無かったことになった」ように見えていた
 * - **downloadTotal を超えた時点で打ち切られる。** 当てずっぽうの見積もりでは
 *   なく、測った合計を渡す
 */
async function probeDownloads(requests: string[]): Promise<{ urls: string[]; total: number | null }> {
    const urls: string[] = [];
    let total = 0;
    for (const url of requests) {
        const video = url.includes('/file?');
        try {
            const res = await fetch(url, { method: 'HEAD' });
            if (!res.ok) {
                if (video) throw new Error('動画を取得できませんでした');
                continue; // 無い付き添いは落とさない
            }
            urls.push(url);
            const length = Number(res.headers.get('content-length'));
            if (Number.isFinite(length) && length > 0) total += length;
        } catch (error) {
            if (video) throw error instanceof Error ? error : new Error('動画を取得できませんでした');
            // 付き添いの下見に失敗しただけなら、そのぶんを諦めて先へ
        }
    }
    return { urls, total: total > 0 ? total : null };
}

/**
 * 端末に保存する。**どちらを落とすかはここで決める** — 既定は AV1、
 * 端末が解けなければ H.264 (両方焼いた録画だけ)。
 */
export async function saveOffline(rec: SaveTarget): Promise<void> {
    let source: 'encoded' | 'alt' = 'encoded';
    if (!(await canPlayAv1())) {
        if (rec.alt_path === null) throw new Error('この端末では AV1 を再生できず、H.264 版もありません');
        source = 'alt';
    }

    // 下見して、在るものだけに絞る (404 が混ざると全体が失敗になる)
    const { urls, total } = await probeDownloads(downloadRequests(rec.id, source));
    await ensureRoom(total ?? rec.ts_size);

    /*
     * 試みの印。やり直しのたびに変える — Background Fetch は**同じ登録IDが
     * 生きている間は再登録できない**ので、前回の残骸が居ても必ず登録できる。
     * 残骸の中止の知らせが遅れて届いても、印が違えばこの控えは消されない (SW の drop)
     */
    const attempt = Math.random().toString(36).slice(2, 10);
    const held: OfflineVideo = {
        id: rec.id,
        name: rec.name,
        serviceName: rec.service_name,
        startAt: rec.start_at,
        durationMs: rec.duration_ms,
        source,
        attempt,
        state: 'downloading',
        downloadedAt: Date.now(),
    };
    await videos.put(held);
    entries = { ...entries, [rec.id]: { state: 'downloading', progress: null } };

    try {
        const reg = await navigator.serviceWorker.ready;
        if (reg.backgroundFetch !== undefined) {
            // 前回の残骸 (失敗して居座っている登録) を先に中止する
            await abortRunning(reg, rec.id);
            // ブラウザに預ける。受け取りは SW (service-worker.ts)。
            // downloadTotal は実測の合計 + 2% (転送の揺れぶん。超えたら打ち切られる)
            const running = await reg.backgroundFetch.fetch(fetchId(rec.id, source, attempt), urls, {
                title: `denpa: ${rec.name}`,
                downloadTotal: total === null ? undefined : Math.round(total * 1.02),
            });
            watchProgress(running);
            return;
        }
        // 対応していないブラウザ。タブを開いたまま、ページで落とす
        await downloadInPage(held, urls);
    } catch (error) {
        await videos.remove(rec.id);
        await refresh();
        throw error;
    }
}

/** 進み具合を数えながら本体を受け取る。Content-Length が無ければ数えない */
async function blobWithProgress(id: number, response: Response): Promise<Blob> {
    const total = Number(response.headers.get('content-length'));
    if (!Number.isFinite(total) || total <= 0 || response.body === null) return await response.blob();

    const parts: BlobPart[] = [];
    let got = 0;
    const reader = response.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        setProgress(id, Math.min(1, got / total));
    }
    return new Blob(parts);
}

/** ページ主導のフォールバック。仕分けは SW の受け取りと同じ (`storeResponse`) */
async function downloadInPage(held: OfflineVideo, requests: string[]): Promise<void> {
    for (const url of requests) {
        const response = await fetch(url).catch(() => null);
        if (response === null || !response.ok) {
            if (url.includes('/file?')) throw new Error('動画を取得できませんでした');
            continue; // 付き添いは無い録画もある
        }
        // 動画だけは進み具合を数えながら読む
        await storeResponse(held, url, response, (r) => blobWithProgress(held.id, r));
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

/** その録画の Background Fetch を全部中止する (試みの印が何であっても) */
async function abortRunning(reg: ServiceWorkerRegistration, id: number): Promise<void> {
    if (reg.backgroundFetch === undefined) return;
    const prefix = fetchIdPrefix(id);
    for (const fetched of await reg.backgroundFetch.getIds()) {
        if (!fetched.startsWith(prefix)) continue;
        const running = await reg.backgroundFetch.get(fetched);
        await running?.abort().catch(() => false);
    }
}

/** 端末からだけ消す (サーバの録画は残す)。保存し直したいときや空けたいとき用 */
export async function removeLocal(id: number): Promise<void> {
    // 運んでいる最中なら、ブラウザに預けたぶんも取り消す
    try {
        await abortRunning(await navigator.serviceWorker.ready, id);
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
async function flush(): Promise<void> {
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
