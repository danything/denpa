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
 * TS を少しずつ食べて、データ放送の変化を実時刻つきで並べる。
 *
 * **食べさせ方は呼ぶ側が決める** — 一気に (`captureDataBroadcast`) でも、
 * 読みながら合間に息をつく (`recorded-bml.ts` の `saveRecordedBml`) でも。
 * 中の解き方は同じ
 */
export class DataBroadcastCapture {
    private readonly timeline: TimedMessage[] = [];
    private readonly decoder: BmlDecoder;

    constructor() {
        // 「配る価値があるか」の判定はライブと同じ土俵に乗せる (pcr は落ち、変わらない
        // pmt/programInfo も落ちる)。中の記憶そのものは使わない — 使うのは take の判定だけ
        const gate = new Carousel();
        let at: number | null = null;
        this.decoder = new BmlDecoder((message) => {
            // 時計は別に持つ。放送の実時刻はここでしか分からない
            if (message.type === 'currentTime') {
                at = message.timeUnixMillis;
                return;
            }
            if (!gate.take(message)) return;
            this.timeline.push({ at, message });
        });
    }

    feed(chunk: Uint8Array): void {
        this.decoder.feed(chunk);
    }

    /** ここまでに並んだ変化。食べ終わってから読む */
    result(): TimedMessage[] {
        return this.timeline;
    }
}

/**
 * TS を解いて、データ放送の変化を実時刻つきで並べる (一気に食べる形)。
 *
 * @param chunks 1局に絞った TS のチャンク列
 */
export function captureDataBroadcast(chunks: Iterable<Uint8Array>): TimedMessage[] {
    const capture = new DataBroadcastCapture();
    for (const chunk of chunks) capture.feed(chunk);
    return capture.result();
}
