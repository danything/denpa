import type { EncodeProgress } from '$lib/server/events';

/**
 * エンコード進捗の**生放送**。SSE の `encode` イベント (中身付き) を録画IDごとに持つ。
 *
 * 進捗は数秒おきに飛んでくる。`recordings` の「変わったよ」で受けていた頃は
 * そのたびにページ全体を読み直していて、遅い回線では往復ぶん数字が遅れた。
 * ここで中身ごと受けて、一覧は該当行の数字だけを書き換える。
 *
 * **消さない。** ジョブが終われば `recordings` イベント → 読み直しで行の
 * `job_state` が変わり、表示の入口 (`{#if job_state === 'running'}`) が閉じる —
 * 残った古い数字は誰からも見えないので、掃除は要らない。
 */

let live = $state<Record<number, EncodeProgress>>({});

export const encodeLive = {
    get entries(): Record<number, EncodeProgress> {
        return live;
    },
};

/** SSE から届いた中身を仕舞う。形が違うものは黙って捨てる (画面を壊さない) */
export function applyEncodeProgress(payload: unknown): void {
    const p = payload as Partial<EncodeProgress> | null;
    if (p === null || typeof p !== 'object' || typeof p.recordingId !== 'number') return;
    if (typeof p.percent !== 'number') return;
    live = {
        ...live,
        [p.recordingId]: {
            recordingId: p.recordingId,
            percent: p.percent,
            etaMs: typeof p.etaMs === 'number' ? p.etaMs : null,
            log: typeof p.log === 'string' ? p.log : '',
        },
    };
}
