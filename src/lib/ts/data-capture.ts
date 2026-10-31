/**
 * 録画のデータ放送を**TS から取り出す側** (サーバ専用)。
 *
 * [data-timeline.ts](data-timeline.ts) の並べ方・再生の側と分けてある —
 * あちらは観る画面 (ブラウザ) も読み込むが、TS をデコードする [bml.ts](../../../packages/arib/src/bml.ts) は
 * `node:zlib` / `node:buffer` を使うのでブラウザには持ち込めない。
 */

import { BmlDecoder } from "@danything/arib/bml";
import { PacketStream } from "@danything/arib/psi";

import { Carousel } from "./carousel";
import type { TimedMessage } from "./data-timeline";
import { TsHead } from "./ts-head";

/**
 * TS を少しずつ食べて、データ放送の変化を実時刻つきで並べる。
 *
 * **食べさせ方は呼ぶ側が決める** (`recorded-bml.ts` の `saveRecordedBml` は、読みながら合間に息をつく)
 */
export class DataBroadcastCapture {
  private readonly timeline: TimedMessage[] = [];
  private readonly packets = new PacketStream();
  private readonly decoder: BmlDecoder;
  private readonly measure = new TsHead();

  constructor() {
    // 「配る価値があるか」の判定はライブと同じ土俵に乗せる (変わらない pmt は
    // 落ちる)。中の記憶そのものは使わない — 使うのは take の判定だけ
    const gate = new Carousel();
    let at: number | null = null;
    this.decoder = new BmlDecoder((message) => {
      // 時計は別に持つ。放送の実時刻はここでしか分からない
      if (message.type === "currentTime") {
        at = message.timeUnixMillis;
        return;
      }
      if (!gate.take(message)) return;
      this.timeline.push({ at, message });
    });
  }

  /**
   * **ファイルの頭 (再生位置 0 の手前) の放送実時刻** (unix ms)。TDT を一度も見ていなければ null。
   * 測り方は [ts-head.ts](ts-head.ts)。DB の予定 (`start_at`) から推さず、TS そのものから測る
   */
  get head(): number | null {
    return this.measure.head;
  }

  feed(chunk: Uint8Array): void {
    for (const packet of this.packets.feed(chunk)) {
      this.measure.feedPacket(packet);
      this.decoder.feedPacket(packet);
    }
  }

  /** ここまでに並んだ変化。食べ終わってから読む */
  result(): TimedMessage[] {
    return this.timeline;
  }
}
