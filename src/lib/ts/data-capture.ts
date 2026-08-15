/**
 * 録画のデータ放送を**TS から拾う側** (サーバ専用)。
 *
 * [data-timeline.ts](data-timeline.ts) の並べ方・再生の側と分けてある —
 * あちらは観る画面 (ブラウザ) も読み込むが、TS を解く [bml.ts](bml.ts) は
 * `node:zlib` / `node:buffer` を使うのでブラウザには持ち込めない。同居させていた
 * 頃はブラウザ向けのビルドが「externalized for browser compatibility」と
 * 警告し続けていた (実害は無いが、警告に慣れると本物を見落とす)。
 */

import { BmlDecoder } from './bml';
import { Carousel } from './carousel';
import type { TimedMessage } from './data-timeline';

/**
 * TS を解いて、データ放送の変化を実時刻つきで並べる。
 *
 * @param chunks 1局に絞った TS のチャンク列 (録画の生TSをそのまま流してよい)
 */
export function captureDataBroadcast(chunks: Iterable<Uint8Array>): TimedMessage[] {
    const timeline: TimedMessage[] = [];
    // 「配る価値があるか」の判定はライブと同じ土俵に乗せる (pcr は落ち、変わらない
    // pmt/programInfo も落ちる)。中の記憶そのものは使わない — 使うのは take の判定だけ
    const gate = new Carousel();
    let at: number | null = null;
    const decoder = new BmlDecoder((message) => {
        // 時計は別に持つ。放送の実時刻はここでしか分からない
        if (message.type === 'currentTime') {
            at = message.timeUnixMillis;
            return;
        }
        if (!gate.take(message)) return;
        timeline.push({ at, message });
    });
    for (const chunk of chunks) decoder.feed(chunk);
    return timeline;
}
