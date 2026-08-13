/**
 * サーバ側で起きた変化をブラウザへ push するための小さな仕組み。
 *
 * これまでは画面が数秒おきに読み直していたが、
 * 「待機中のジョブが動き出した」ようにこちらが知っている変化を伝えられないのが
 * 無駄でもあり取りこぼしでもあった。
 *
 * WebSocket ではなく SSE を使う。伝えたいのはサーバ→ブラウザの一方向だけで、
 * SSE なら普通のHTTPなので逆プロキシもそのまま通る
 * (SvelteKit + adapter-node で WebSocket を扱うには自前のサーバが要る)。
 */

export type DenpaEvent =
    | 'recordings'
    | 'reservations'
    | 'migrate'
    | 'scan'
    | 'services'
    /** 番組表が増えた・書き換わった。1チャンネル集め終わるたびに飛ぶ */
    | 'programs'
    /** 局ロゴを取りに行っている最中の進み具合。1チャンネルに数分かかる */
    | 'logos'
    | 'tuners'
    /**
     * エンコードの進み具合。**これだけ中身 (payload) を運ぶ** — 数秒おきに
     * 飛ぶので、そのたびにページ全体を読み直させない。画面は該当行の
     * 数字だけを書き換える (`encode-live.svelte.ts`)
     */
    | 'encode';

/** `encode` イベントの中身。一覧の行を名指しで書き換えられるだけの情報 */
export interface EncodeProgress {
    recordingId: number;
    percent: number;
    etaMs: number | null;
    log: string;
}

type Listener = (event: DenpaEvent, payload?: unknown) => void;

const listeners = new Set<Listener>();

export function emit(event: DenpaEvent, payload?: unknown): void {
    for (const listener of listeners) {
        try {
            listener(event, payload);
        } catch {
            // 1つの購読者の失敗で他に波及させない
        }
    }
}

export function subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}
