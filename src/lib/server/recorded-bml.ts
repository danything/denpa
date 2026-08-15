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
import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';
import type { Recording } from '../types';
import { queryOne } from './db';

/**
 * **番組の名乗り (`programInfo`)。描く側はこれが来るまで入口の BML を開かない**
 * (web-bml の `content.ts` が `getProgramInfoAsync` を待つ) ので、無いと
 * 「データ取得中…」のまま何も出ない。TS からは取り出していない (EIT は解かない) ので、
 * ライブと同じく DB から組み立てる (`live.ts` の `programInfo`)。局の番号は
 * `services`、番組は録画の行が持っている
 */
export function programInfoOf(recording: Recording): ResponseMessage | null {
    const service = queryOne<{ service_id: number; network_id: number }>(
        'SELECT service_id, network_id FROM services WHERE id = ?',
        recording.service_id,
    );
    if (service === undefined) return null;
    const program = queryOne<{ event_id: number }>(
        'SELECT event_id FROM programs WHERE id = ?',
        recording.program_id,
    );
    return {
        type: 'programInfo',
        originalNetworkId: service.network_id,
        networkId: service.network_id,
        transportStreamId: null,
        serviceId: service.service_id,
        eventId: program?.event_id ?? null,
        eventName: recording.name,
        startTimeUnixMillis: recording.start_at,
        durationSeconds: Math.round((recording.end_at - recording.start_at) / 1000),
        indefiniteDuration: false,
    };
}

/**
 * 変化ログの頭に番組の名乗りを足す。**サイドカーに書くときも、読むときも通す** —
 * 書く側で足しておけば端末に保存した写しでも効き、読む側でも足すのは、
 * 名乗りを書いていなかった頃のサイドカーをそのまま生かすため
 */
export function withProgramInfo(timeline: PlacedMessage[], recording: Recording): PlacedMessage[] {
    if (timeline.length === 0 || timeline.some((item) => item.message.type === 'programInfo'))
        return timeline;
    const info = programInfoOf(recording);
    return info === null ? timeline : [{ at: 0, message: info }, ...timeline];
}

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
 * @param recording 録画の行。`start_at` を再生位置 0 の放送実時刻に、番組の名乗りにも使う
 * @param keep CM を実カットした録画で残した区間 (秒)。off/chapter なら null
 * @returns 書いた変化の数。**0 なら書かない** (データ放送を持たない録画)
 */
export function saveRecordedBml(
    tsPath: string,
    sidecarPath: string,
    recording: Recording,
    keep: readonly KeptRange[] | null,
): number {
    const timeline = captureDataBroadcast(tsChunks(tsPath));
    /*
     * **描けるモジュールが1つも無ければ書かない。** データ放送の載っていない局でも
     * `pmt` は必ず1つ出る (timeline は空にならない) ので、それだけでは持たせない —
     * 実際に画面になるのは `moduleDownloaded`。無ければサイドカーを作らない
     */
    if (!timeline.some((item) => item.message.type === 'moduleDownloaded')) return 0;
    const placed = withProgramInfo(toPlaybackTimeline(timeline, recording.start_at, keep), recording);
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
