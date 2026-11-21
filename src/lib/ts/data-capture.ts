/**
 * 録画のデータ放送を**TS から取り出す側** (サーバ専用)。
 *
 * [data-timeline.ts](data-timeline.ts) の並べ方・再生の側と分けてある。
 * あちらは観る画面 (ブラウザ) も読み込むが、TS をデコードする [bml.ts](../../../packages/arib/src/bml.ts) は
 * `node:zlib` / `node:buffer` を使うのでブラウザには持ち込めない。
 */

import { BmlDecoder } from "@danything/arib/bml";
import { PacketStream } from "@danything/arib/psi";

import { Carousel } from "./carousel";
import { stcUnixMs } from "./clock";
import type { TimedMessage } from "./data-timeline";
import { TsHead } from "./ts-head";

/**
 * TS を少しずつ読んで、データ放送の変化を実時刻つきで並べる。
 *
 * **渡し方は呼ぶ側が決める** (`recorded-bml.ts` の `saveRecordedBml` は、読みながら合間にほかの処理へ譲る)
 */
export class DataBroadcastCapture {
  private readonly timeline: TimedMessage[] = [];
  private readonly packets = new PacketStream();
  private readonly decoder: BmlDecoder;
  private readonly measure = new TsHead();

  constructor() {
    // 「配る価値があるか」の判定はライブと同じものを使う (変わらない pmt は
    // 落ちる)。中の記憶そのものは使わず、take の判定だけを使う
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
   * **ファイルの先頭 (再生位置 0 の手前) の放送実時刻** (unix ms)。TDT を一度も見ていなければ null。
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

  /**
   * ここまでに並んだ変化。渡し終えてから読む。
   *
   * **NPT 参照には、TS の先頭から PCR が進んだぶんで時刻を付ける** (`nptUpdated` の `timeUnixMillis`)。観る画面は再生位置を
   * 同じ物差しで放送の時刻に直す (`watch/[id]` の `airTime`) ので、TDT のずれは入らない。ffmpeg が先頭を最初の PTS に寄せるぶん
   * (`ts-head.ts`。1 秒足らず) だけ NPT が遅れる。並べる位置 (`at`) は TDT の粒度のまま (ほかの変化と同じ順に並べるため)。先頭は TDT を見るまで決まらないので、ここで付ける
   */
  result(): TimedMessage[] {
    const anchor = this.measure.anchor;
    if (anchor !== null)
      for (const { message } of this.timeline)
        if (message.type === "nptUpdated")
          message.timeUnixMillis = stcUnixMs(anchor, message.stc);
    return this.timeline;
  }
}
