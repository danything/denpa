/**
 * 録画のデータ放送。**TS から取り出して、サイドカーに置いておく。**
 *
 * ライブは今のカルーセルをそのまま流せばよいが、録画は巻き戻し・番組またぎが
 * あるので、**いつ何が変わったか**を再生位置つきで持っておく必要がある
 * (解き方と写し方は [ts/data-timeline.ts](../ts/data-timeline.ts))。
 *
 * ここは**ファイルの出し入れだけ**。エンコードのついでに元TSをもう一度解いて
 * (`saveRecordedBml`)、再生時に読む (`loadRecordedBml`)。中身は1行1メッセージの
 * JSONL で、字幕やサムネイルと同じ**録画の隣**に置く (`metadata.sidecarPaths`)。
 *
 * **録画のTSは1局に絞ってある** (実機の録画で PAT のプログラムは1つ) ので、
 * ライブのような `ServiceFilter` は要らない — [ts/bml.ts](../ts/bml.ts) の
 * `BmlDecoder` にそのまま流せる。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { captureDataBroadcast } from '$lib/ts/data-capture';
import { type KeptRange, type PlacedMessage, toPlaybackTimeline } from '$lib/ts/data-timeline';

/** TS を 1MB ずつ読む。**丸ごと抱えない** — 録画は数GBになる */
function* tsChunks(path: string, size = 1 << 20): Generator<Uint8Array> {
    const fd = openSync(path, 'r');
    try {
        const buffer = Buffer.alloc(size);
        for (;;) {
            const read = readSync(fd, buffer, 0, size, null);
            if (read <= 0) break;
            // 使い回すバッファなので、その回のぶんを写して渡す
            yield Uint8Array.prototype.slice.call(buffer, 0, read);
        }
    } finally {
        closeSync(fd);
    }
}

/**
 * 録画のデータ放送を取り出して、サイドカーに書く。
 *
 * @param tsPath 元の生TS (**CMを切る前のほう**。放送の実時刻 (TDT) が続いている)
 * @param sidecarPath 書き先 (`metadata.sidecarPaths` の `dataBroadcast`)
 * @param anchorMs 再生位置 0 のときの放送実時刻。録画の `start_at` を渡す
 * @param keep CM を実カットした録画で残した区間 (秒)。off/chapter なら null
 * @returns 書いた変化の数。**0 なら書かない** (データ放送を持たない録画)
 */
export function saveRecordedBml(
    tsPath: string,
    sidecarPath: string,
    anchorMs: number,
    keep: readonly KeptRange[] | null,
): number {
    const timeline = captureDataBroadcast(tsChunks(tsPath));
    /*
     * **描けるモジュールが1つも無ければ書かない。** データ放送の載っていない局でも
     * `pmt` は必ず1つ出る (timeline は空にならない) ので、それだけでは持たせない —
     * 実際に画面になるのは `moduleDownloaded`。無ければサイドカーを作らない
     */
    if (!timeline.some((item) => item.message.type === 'moduleDownloaded')) return 0;
    const placed = toPlaybackTimeline(timeline, anchorMs, keep);
    writeFileSync(sidecarPath, `${placed.map((item) => JSON.stringify(item)).join('\n')}\n`);
    return placed.length;
}

/** サイドカーを読む。無ければ空 (データ放送を持たない録画・古い録画) */
export function loadRecordedBml(sidecarPath: string): PlacedMessage[] {
    if (!existsSync(sidecarPath)) return [];
    return readFileSync(sidecarPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as PlacedMessage);
}
