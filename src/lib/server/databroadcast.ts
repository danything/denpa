/**
 * データ放送。**1 局に絞った TS の写しをデコードして、組み立て終わったものを配る。**
 *
 *     エージェント (MPEG-TS) → ServiceFilter ┬→ ffmpeg     → fMP4 / 字幕
 *                                            └→ BmlDecoder → データ放送
 *
 * [stream-history.md](../../../docs/stream-history.md#実装の順序) の 3 番目にあたる。仕組みは
 * [stream.md](../../../docs/stream.md#データ放送の統合)。
 *
 * デコードするのは [packages/arib/src/bml.ts](../../../packages/arib/src/bml.ts)、覚えておくのは [ts/carousel.ts](../ts/carousel.ts)。
 * **ここは入出力の付け替えと、デコードが失敗したときの後始末だけ。**
 *
 * ## リクエストされてからデコードする
 *
 * **リクエストした人がいるときだけ回す** (`Session.wantData`。押した人と、自動で受信する端末が自動起動の指定のある局を映しているとき)。デコードすること自体は安く、
 * 実機の録画で測って**放送の 17 Mbit/s に対して 1 コアの 1.7%** だが、
 * **見ている人のほとんどは押さない**ものなので、全員のぶんをデコードし続ける理由が無い。
 *
 * 引き換えに、**押してから出るまでカルーセルが一周するのを待つ**。放送は同じ
 * ものを何度も回しているので、待てば揃う (実測で数秒〜。大きいモジュールほど
 * 間隔が空く)。
 */

import { BmlDecoder, parsePmt } from "@danything/arib/bml";
import type { ResponseMessage } from "@danything/arib/bml-protocol";

import { Carousel } from "#lib/ts/carousel.js";
import { autoStarts } from "#lib/ts/data-auto-start.js";

import { PmtWatch } from "./pmt-watch";

/**
 * **入口の部品に自動起動の指定があるかを、PMT だけ読んで決める** (`autoStarts`)。カルーセルはデコードしない。
 *
 * データ放送を自動で受信する端末 (`components/player/data-receive.ts`) は、指定のある局でだけ受信をリクエストする。
 * 指定の無い局の入口は d を押すまで始まらない (`bml/engine.ts` の `mayStart`) ので、先に受け取っても使わない。
 * リクエストする前に分かるよう、受信をリクエストした人がいなくても読む (`PmtWatch`)
 */
export class AutoStartWatch extends PmtWatch<boolean> {
  /** @param program 放送が名乗っている番号 */
  constructor(program: number) {
    super(program, (section) => autoStarts(parsePmt(section)));
  }
}

/**
 * TS を渡すと、組み立て終わったものを返す。
 *
 * **1 つの選局に 1 つ。** 局を変えたら作り直す。カルーセルは局ごとに別物で、
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
   * 1 局に絞った TS の、切り分け済みのパケットを 1 つ (`BmlDecoder.feedPacket`)。**デコードが例外を送出しても外へ送出し直さない。**
   *
   * データ放送は映像の付け足しなので、デコードが失敗したらデコードだけやめて、映像は
   * 流し続ける。**送出し直すと TS を送り込んでいるところ (`Session.tap`。`pump` と `runRaw` の両方から呼ぶ) ごと
   * 止まり、映像まで出なくなる。**
   */
  feedPacket(packet: Uint8Array): void {
    if (this.closed) return;
    try {
      this.decoder.feedPacket(packet);
    } catch (error) {
      this.fell(error);
    }
  }

  private fell(error: unknown): void {
    // 出力するのは 1 回だけ。失敗し続けると記録がそれで埋まる
    console.error(`[data] データ放送をデコードするのをやめました: ${error}`);
    this.close();
  }

  /** 繋いできた人に配り直すぶん ([Carousel](../ts/carousel.ts)) */
  replay(): ResponseMessage[] {
    return this.held.replay();
  }

  close(): void {
    this.closed = true;
  }
}
