/**
 * データ放送。**1局に絞った TS の写しを解いて、組み立て終わったものを配る。**
 *
 *     エージェント (MPEG-TS) → ServiceFilter ┬→ ffmpeg   → fMP4 / 字幕の絵
 *                                            └→ decodeTS → データ放送
 *
 * [stream.md](../../../docs/stream.md) §5.6 にあたる第3段階。
 *
 * ## 解くところは web-bml から借りる
 *
 * 放送に載っているのは DSM-CC のカルーセルで、**同じものが何度も回ってくる**中から
 * ブロックを拾って組み立て直すと、はじめて1つのファイルになる。そこを解くのが
 * [vendor/web-bml](../vendor/web-bml/README.md) の `decodeTS()` で、**TS を流し込むと
 * 組み立て終わったモジュールが出てくる**。denpa 側で書くのはその前後だけ。
 *
 * **自前で書き直す道は採らない。** カルーセルの組み立てだけでは終わらず、BML の
 * スクリプトを動かす ES2 の処理系まで抱えることになる (借りている側の README に実測)。
 *
 * ## 頼まれてから解く
 *
 * **押した人が居るときだけ回す** (`Session.wantData`)。解くこと自体は安く、
 * 実機の録画で測って**放送の 17 Mbit/s に対して1コアの 1.8%** (83MB を 0.69秒)
 * だが、**見ている人のほとんどは押さない**ものなので、全員のぶんを解き続ける
 * 理由が無い。
 *
 * 引き換えに、**押してから出るまでカルーセルが一周するのを待つ**。放送は同じ
 * ものを何度も回しているので、待てば揃う (実測で数秒〜。大きいモジュールほど
 * 間隔が空く)。
 *
 * 覚えておくぶんは [ts/carousel.ts](../ts/carousel.ts)。ここは口の付け替えだけ。
 */

import { Carousel } from '$lib/ts/carousel';
import { decodeTS } from '$lib/vendor/web-bml/decode_ts';
import type { ResponseMessage } from '$lib/vendor/web-bml/ws_api';

export type { ResponseMessage };

/**
 * TS を食わせると、組み立て終わったものを吐く。
 *
 * **1つの選局に1つ。** 局を変えたら作り直す — カルーセルは局ごとに別物で、
 * 覚えているモジュールを持ち越すと前の局の画面が出る。
 */
export class DataBroadcast {
    private readonly stream: ReturnType<typeof decodeTS>;
    private readonly held = new Carousel();
    private closed = false;

    /**
     * @param serviceId 局。**丸ごとの TS を渡すときだけ要る** — こちらは絞った
     *   あとを渡すので、渡さなくても1局しか入っていない
     * @param onMessage 組み立て終わったものが出るたび
     */
    constructor(
        serviceId: number | undefined,
        private readonly onMessage: (message: ResponseMessage) => void,
    ) {
        this.stream = decodeTS({
            serviceId,
            sendCallback: (message: ResponseMessage) => {
                if (this.closed) return;
                // 配る価値のあるものだけ通す ([Carousel](../ts/carousel.ts))
                if (this.held.take(message)) this.onMessage(message);
            },
        });
        /*
         * **読み出し側を空けておく。** decodeTS は Transform なので、出口を
         * 誰も読まないと詰まってそこで止まる (欲しいものは `sendCallback` で
         * 受け取っていて、出口の TS そのものには用が無い)
         */
        this.stream.resume();
        /*
         * **終わりの覚え書きは黙らせる。** 借りている側は畳むときに PID ごとの
         * 統計を30行ほど吐く。1回の選局につき30行で、局を変えるたびに積もるので、
         * **本当の失敗がその中に埋もれる** (字幕でも同じことをしている
         * `captions.ts` の `NOISE`)。
         *
         * 借りものは書き換えない。**聞き耳を外すだけ**で消える
         */
        this.stream.removeAllListeners('info');
        /*
         * **転んでも映像は止めない。**
         *
         * Node のストリームは `error` を誰も聞いていないと**投げる**ので、
         * 解く側が転ぶと TS を送り込んでいるところ (`Session.pump`) ごと落ちて、
         * **映像まで出なくなる**。実際に落とした — 作りものの放送 (e2e) で
         * 「映像を出せませんでした」になった。
         *
         * データ放送は映像の付け足しなので、転んだらそこで諦めて、映像は流し続ける
         */
        this.stream.on('error', (error: unknown) => this.give(error));
    }

    /** 1局に絞った TS を食わせる。**転んでも投げ返さない** (上の説明) */
    feed(chunk: Uint8Array): void {
        if (this.closed) return;
        try {
            this.stream.write(Buffer.from(chunk));
        } catch (error) {
            this.give(error);
        }
    }

    /** 諦める。**言うのは1回だけ** — 転び続けると記録がそれで埋まる */
    private give(error: unknown): void {
        if (this.closed) return;
        console.error(`[data] データ放送を解くのをやめました: ${error}`);
        this.close();
    }

    /** 繋いできた人に配り直すぶん ([Carousel](../ts/carousel.ts)) */
    replay(): ResponseMessage[] {
        return this.held.replay();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try {
            this.stream.end();
        } catch {
            // もう閉じている
        }
    }
}
