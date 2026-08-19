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

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { DataBroadcastCapture } from '$lib/ts/data-capture';
import {
    type KeptRange,
    type PlacedMessage,
    type TimedMessage,
    toPlaybackTimeline,
} from '$lib/ts/data-timeline';
import type { ResponseMessage } from '$lib/vendor/web-bml/server/ws_api';
import type { Recording } from '../types';
import { queryOne } from './db';

/**
 * **番組の名乗り (`programInfo`)。描く側はこれが来るまで入口の BML を開かない**
 * (web-bml の `content.ts` が `getProgramInfoAsync` を待つ) ので、無いと
 * 「データ取得中…」のまま何も出ない。TS からは取り出していない (EIT は解かない) ので、
 * ライブと同じく DB から組み立てる (`live.ts` の `programInfo`)。局の番号は
 * `services`、番組は録画の行が持っている。
 *
 * **中継の番号 (`transportStreamId`) は null のままにします。** ライブでは放送から
 * 拾って渡していますが (あちらは TVerリンクが訊いてくる)、**放送のアプリは録画の
 * 再生中に双方向をやりません** — テレ朝の TVerリンクは `IsRecorded()` で分かれて
 * 「録画再生中は、このサービスをご利用いただけません」を出す。訊かれないものを
 * 録画の行に足しても、確かめようが無い
 */
function programInfoOf(recording: Recording): ResponseMessage | null {
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
 * 書く側は `event_id` が番組表から消える前に写し取るため (`epg.ts` の
 * `pruneOldPrograms`)、読む側は名乗りを書いていなかった頃のサイドカーのため
 */
export function withProgramInfo(timeline: PlacedMessage[], recording: Recording): PlacedMessage[] {
    if (timeline.length === 0 || timeline.some((item) => item.message.type === 'programInfo'))
        return timeline;
    const info = programInfoOf(recording);
    return info === null ? timeline : [{ at: 0, message: info }, ...timeline];
}

/**
 * TS を 1MB ずつ読んで解く。**丸ごと抱えない** (録画は数GBになる) し、
 * **読む間も息をつく** (チャンクごとに await)。
 *
 * 前は同期の `readSync` で回していた — 10GB の録画 (2時間の映画) では
 * イベントループが数分止まり、その間 `/api/health` が返せず、Kubernetes の
 * 生存確認 (1秒で3回) に落ちて SIGTERM → 再起動 → エンコードのやり直し、
 * を **1周 2時間で 5回** 繰り返した (2026-08-17 実機)。エンコードそのものは
 * 終わっていて、最後のこの一手で全部を捨てていた
 */
async function capture(path: string, size = 1 << 20): Promise<TimedMessage[]> {
    const capture = new DataBroadcastCapture();
    const file = await open(path, 'r');
    try {
        const buffer = Buffer.alloc(size);
        for (;;) {
            const { bytesRead } = await file.read(buffer, 0, size, null);
            if (bytesRead <= 0) break;
            capture.feed(buffer.subarray(0, bytesRead));
        }
    } finally {
        await file.close();
    }
    return capture.result();
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
export async function saveRecordedBml(
    tsPath: string,
    sidecarPath: string,
    recording: Recording,
    keep: readonly KeptRange[] | null,
): Promise<number> {
    const timeline = await capture(tsPath);
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
