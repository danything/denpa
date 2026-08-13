/**
 * オフライン視聴の置き場 (IndexedDB)。**ページとサービスワーカーの両方から使う**ので、
 * Svelte に依存しないただの層にしてある ([docs/offline.md](../../docs/offline.md))。
 *
 * - `videos` … 落とした録画。動画の blob と、観るのに要る付き添い
 *   (字幕・チャプター・データ放送・ポスター) を1行にまとめて持つ
 * - `outbox` … オンラインに戻ったときにサーバへ伝えること (いまは削除だけ)
 * - `resume` … オフライン中に進んだ視聴位置。復帰時にまとめて送る
 */

const DB = 'denpa-offline';
const VERSION = 1;

/** 落とした録画1本。付き添いは取れなかったら無いまま (観るときに諦める) */
export interface OfflineVideo {
    id: number;
    name: string;
    /** 局名。/offline の一覧に出す */
    serviceName: string;
    startAt: number;
    /** 実際に録れた長さ (ms)。無ければ null */
    durationMs: number | null;
    /** どちらを落としたか。端末が AV1 を解けなければ alt (H.264) */
    source: 'encoded' | 'alt';
    /**
     * 何回目の試みか (でたらめな文字列)。**やり直しと前回の残骸を見分ける印。**
     * 前回の失敗を中止してからやり直すとき、その中止の知らせが遅れて届いても、
     * 印が違えば新しい控えを消さない (service-worker.ts の drop)
     */
    attempt?: string;
    /** `downloading` は Background Fetch がまだ運んでいる最中 */
    state: 'downloading' | 'ready';
    downloadedAt: number;
    /** 動画の実体。downloading の間は無い */
    video?: Blob;
    captions?: Blob;
    poster?: Blob;
    chapters?: unknown;
    databroadcast?: unknown;
}

export interface OutboxItem {
    id: number;
    op: 'delete';
    /** 何を消すのか、処理の記録に名前で残す */
    name: string;
    queuedAt: number;
}

export interface ResumeItem {
    id: number;
    /** 再生位置 (秒)。サーバの `PUT` と同じ形 */
    at: number;
    length: number;
    updatedAt: number;
}

/**
 * Background Fetch の登録ID。`rec-<録画ID>-<どちらを落とすか>-<試みの印>`。
 *
 * **試みの印を含める。** 同じIDが生きている間は再登録できない
 * (`There already is a registration for the given id`) — 前回の失敗の残骸が
 * ブラウザに残っていると、やり直しがそのまま断られていた。試みごとに
 * 変えれば必ず登録でき、残骸は登録前に中止する (offline.svelte.ts)
 */
export function fetchId(id: number, source: 'encoded' | 'alt', attempt: string): string {
    return `rec-${id}-${source}-${attempt}`;
}

/** その録画の登録IDか。残骸を探して中止するときの当たり判定 */
export function fetchIdPrefix(id: number): string {
    return `rec-${id}-`;
}

/** 登録IDを読み戻す。Background Fetch の成否イベントは ID しか持っていない */
export function parseFetchId(
    value: string,
): { id: number; source: 'encoded' | 'alt'; attempt: string } | null {
    // 印の無い古い形 (rec-42-encoded) も読める。付ける前に預けたぶんが残っていることがある
    const m = /^rec-(\d+)-(encoded|alt)(?:-([a-z0-9]+))?$/.exec(value);
    if (m === null) return null;
    return { id: Number(m[1]), source: m[2] as 'encoded' | 'alt', attempt: m[3] ?? '' };
}

/** 落とすものの一覧。動画 + 観るのに要る付き添い */
export function downloadRequests(id: number, source: 'encoded' | 'alt'): string[] {
    return [
        `/api/recordings/${id}/file?source=${source}`,
        `/api/recordings/${id}/captions.sup`,
        `/api/recordings/${id}/chapters`,
        `/api/recordings/${id}/databroadcast`,
        `/api/recordings/${id}/poster`,
    ];
}

/** URL がどの付き添いか。Background Fetch の結果を仕分けるのに使う */
export function kindOf(url: string): 'video' | 'captions' | 'chapters' | 'databroadcast' | 'poster' | null {
    const path = new URL(url, 'http://x').pathname;
    if (path.endsWith('/file')) return 'video';
    if (path.endsWith('/captions.sup')) return 'captions';
    if (path.endsWith('/chapters')) return 'chapters';
    if (path.endsWith('/databroadcast')) return 'databroadcast';
    if (path.endsWith('/poster')) return 'poster';
    return null;
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('resume')) db.createObjectStore('resume', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

type Store = 'videos' | 'outbox' | 'resume';

async function tx<T>(
    store: Store,
    mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    const db = await openDb();
    try {
        return await new Promise<T>((resolve, reject) => {
            const req = run(db.transaction(store, mode).objectStore(store));
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } finally {
        db.close();
    }
}

export const videos = {
    get: (id: number) => tx<OfflineVideo | undefined>('videos', 'readonly', (s) => s.get(id)),
    all: () => tx<OfflineVideo[]>('videos', 'readonly', (s) => s.getAll()),
    put: (value: OfflineVideo) => tx('videos', 'readwrite', (s) => s.put(value)),
    remove: (id: number) => tx('videos', 'readwrite', (s) => s.delete(id)),
};

export const outbox = {
    all: () => tx<OutboxItem[]>('outbox', 'readonly', (s) => s.getAll()),
    put: (value: OutboxItem) => tx('outbox', 'readwrite', (s) => s.put(value)),
    remove: (id: number) => tx('outbox', 'readwrite', (s) => s.delete(id)),
};

export const resumeQueue = {
    all: () => tx<ResumeItem[]>('resume', 'readonly', (s) => s.getAll()),
    put: (value: ResumeItem) => tx('resume', 'readwrite', (s) => s.put(value)),
    remove: (id: number) => tx('resume', 'readwrite', (s) => s.delete(id)),
};
