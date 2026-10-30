/**
 * サーバ側で起きた変化をブラウザへ push するための小さな仕組み。画面が数秒おきに
 * 読み直すやり方では、こちらが知っている変化 (待機中のジョブが動き出した等) を伝えられない。
 *
 * WebSocket ではなく SSE を使う。伝えたいのはサーバ→ブラウザの一方向だけで、
 * SSE なら普通のHTTPなので逆プロキシも SvelteKit もそのまま通る
 * (WebSocket は入口の `server.js` でしか受けられない。`ws.ts`)。
 */

import type { YieldedRecording } from "#lib/live.js";

export type DenpaEvent =
  | "recordings"
  | "reservations"
  | "migrate"
  | "scan"
  | "services"
  /** 番組表が増えた・書き換わった。書くたびに飛ぶ (集めている間は読めたぶんを30秒ごとに書く。`epg-collect.collectChannel`) */
  | "programs"
  /** 局ロゴを取得している最中の進み具合。1チャンネルに数分かかる */
  | "logos"
  | "tuners"
  /**
   * エンコードの進み具合。**これだけ中身 (payload) を運ぶ** — 数秒おきに
   * 飛ぶので、そのたびにページ全体を読み直させない。画面は該当行の
   * 数字だけを書き換える (`encode-live.svelte.ts`)
   */
  | "encode"
  /**
   * **ライブがチューナーを録画に譲った** (`server/live.ts` の `lose`)。中身は `Yielded`。
   * HTTP でライブを観ているもの (テレビのアプリ) 向け — ストリームの中では伝えられないので、ここで知る。
   * 画面 (WebSocket) は同じものを `lost` の通知で受け取るので、これは読まない
   */
  | "yielded"
  /**
   * **録画のチャプターが書き換わった** (CM検出のやり直し。`encoder.runCmJob`)。中身は `ChaptersChanged`。
   * 開いている観る画面がチャプターを取り直す — 開いたときに読んだきりなので、CM飛ばしとシークバーが古いままになる
   */
  | "chapters"
  /** 切り抜きが増えた・消えた (`server/clips.ts`)。開いている切り抜きの画面が読み直す */
  | "clips";

/** `chapters` イベントの中身 */
export interface ChaptersChanged {
  recordingId: number;
}

/** `yielded` イベントの中身 */
export interface Yielded {
  /** 外されたライブの局 (`services.id`)。その局を観ていた人だけが読む */
  serviceId: number;
  recording: YieldedRecording;
}

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
