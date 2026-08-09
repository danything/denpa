/**
 * データ放送。**1局に絞った TS の写しを解いて、組み立て終わったものを配る。**
 *
 *     エージェント (MPEG-TS) → ServiceFilter ┬→ ffmpeg     → fMP4 / 字幕の絵
 *                                            └→ BmlDecoder → データ放送
 *
 * [stream.md](../../../docs/stream.md) §5.6 にあたる第3段階。
 *
 * 解くのは [ts/bml.ts](../ts/bml.ts)、覚えておくのは [ts/carousel.ts](../ts/carousel.ts)。
 * **ここは口の付け替えと、転んだときの畳み方だけ。**
 *
 * ## 頼まれてから解く
 *
 * **押した人が居るときだけ回す** (`Session.wantData`)。解くこと自体は安く、
 * 実機の録画で測って**放送の 17 Mbit/s に対して1コアの 1.8%** だが、
 * **見ている人のほとんどは押さない**ものなので、全員のぶんを解き続ける理由が無い。
 *
 * 引き換えに、**押してから出るまでカルーセルが一周するのを待つ**。放送は同じ
 * ものを何度も回しているので、待てば揃う (実測で数秒〜。大きいモジュールほど
 * 間隔が空く)。
 */

import { BmlDecoder } from '$lib/ts/bml';
import { Carousel } from '$lib/ts/carousel';
import type { ResponseMessage } from '$lib/vendor/web-bml/ws_api';

export type { ResponseMessage };

/**
 * TS を食わせると、組み立て終わったものを吐く。
 *
 * **1つの選局に1つ。** 局を変えたら作り直す — カルーセルは局ごとに別物で、
 * 覚えているモジュールを持ち越すと前の局の画面が出る。
 */
export class DataBroadcast {
    private readonly decoder: BmlDecoder;
    private readonly held = new Carousel();
    private closed = false;

    /** @param onMessage 組み立て終わったものが出るたび */
    constructor(private readonly onMessage: (message: ResponseMessage) => void) {
        this.decoder = new BmlDecoder((message) => {
            if (this.closed) return;
            // 配る価値のあるものだけ通す ([Carousel](../ts/carousel.ts))
            if (this.held.take(message)) this.onMessage(message);
        });
    }

    /**
     * 1局に絞った TS を食わせる。**転んでも投げ返さない。**
     *
     * データ放送は映像の付け足しなので、解く側が転んだらそこで諦めて、映像は
     * 流し続ける。**投げ返すと TS を送り込んでいるところ (`Session.pump`) ごと
     * 落ちて、映像まで出なくなる** — 実際に落としたことがある。
     */
    feed(chunk: Uint8Array): void {
        if (this.closed) return;
        try {
            this.decoder.feed(chunk);
        } catch (error) {
            // 言うのは1回だけ。転び続けると記録がそれで埋まる
            console.error(`[data] データ放送を解くのをやめました: ${error}`);
            this.close();
        }
    }

    /** 繋いできた人に配り直すぶん ([Carousel](../ts/carousel.ts)) */
    replay(): ResponseMessage[] {
        return this.held.replay();
    }

    close(): void {
        this.closed = true;
    }
}
