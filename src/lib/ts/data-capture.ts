/**
 * 録画のデータ放送を**TS から取り出す側** (サーバ専用)。
 *
 * [data-timeline.ts](data-timeline.ts) の並べ方・再生の側と分けてある —
 * あちらは観る画面 (ブラウザ) も読み込むが、TS をデコードする [bml.ts](../../../packages/arib/src/bml.ts) は
 * `node:zlib` / `node:buffer` を使うのでブラウザには持ち込めない。
 */

import { BmlDecoder } from "@danything/arib/bml";
import { CLOCK, WRAP } from "@danything/arib/pes";
import { PacketStream } from "@danything/arib/psi";

import { Carousel } from "./carousel";
import { BroadcastClock } from "./clock";
import type { TimedMessage } from "./data-timeline";

/** 33ビットで一周する長さ (秒) */
const PCR_WRAP = WRAP / CLOCK;

/**
 * TS を少しずつ食べて、データ放送の変化を実時刻つきで並べる。
 *
 * **食べさせ方は呼ぶ側が決める** (`recorded-bml.ts` の `saveRecordedBml` は、読みながら合間に息をつく)
 */
export class DataBroadcastCapture {
  private readonly timeline: TimedMessage[] = [];
  private readonly packets = new PacketStream();
  private readonly decoder: BmlDecoder;
  /** PCR を読む (1局に絞ってあるので、PMT の言う PID のもの) */
  private readonly clock = new BroadcastClock();
  /** ファイルで最初に読めた PCR (秒) */
  private firstPcr = Number.NaN;
  private headAt: number | null = null;

  constructor() {
    // 「配る価値があるか」の判定はライブと同じ土俵に乗せる (変わらない pmt/programInfo は
    // 落ちる)。中の記憶そのものは使わない — 使うのは take の判定だけ
    const gate = new Carousel();
    let at: number | null = null;
    this.decoder = new BmlDecoder((message) => {
      // 時計は別に持つ。放送の実時刻はここでしか分からない
      if (message.type === "currentTime") {
        at = message.timeUnixMillis;
        this.headAt ??= Math.round(at - this.sinceHead() * 1000);
        return;
      }
      if (!gate.take(message)) return;
      this.timeline.push({ at, message });
    });
  }

  /**
   * **ファイルの頭 (再生位置 0 の手前) の放送実時刻** (unix ms)。TDT を一度も見ていなければ null。
   *
   * 録画の頭は番組の始まり (`start_at`) ではない。前のマージン (`START_MARGIN`) のぶん早く、
   * 予約の見回り (5秒おき) とチューナーを開くぶん遅れ、取り合いで頭を譲れば
   * (`record_from`) 何分もずれる。DB の予定から推すとこれらがそのままデータ放送のずれになるので、
   * **TS そのものから測る** — 最初の TDT の時刻から、そこまでに PCR が進んだぶんを引く。
   * PCR は映像の時刻と同じ時計なので、ffmpeg が数える「入れ物の頭からの秒」と揃う
   * (ffmpeg の頭は最初の PTS で、最初の PCR より 1秒足らず後。そのぶん遅れて出るが、
   * データ放送は秒単位で動くので効かない)
   */
  get head(): number | null {
    return this.headAt;
  }

  /** ファイルの頭から、いま読んでいるところまでに PCR が進んだ秒。まだ読めていなければ 0 */
  private sinceHead(): number {
    const now = this.clock.now;
    if (!Number.isFinite(this.firstPcr) || !Number.isFinite(now)) return 0;
    return (((now - this.firstPcr) % PCR_WRAP) + PCR_WRAP) % PCR_WRAP;
  }

  feed(chunk: Uint8Array): void {
    for (const packet of this.packets.feed(chunk)) {
      // 時計を先に進める。同じパケットで TDT が揃ったときに、そこまでの PCR で頭を測る
      this.clock.feedPacket(packet, 0);
      if (Number.isNaN(this.firstPcr)) this.firstPcr = this.clock.now;
      this.decoder.feedPacket(packet);
    }
  }

  /** ここまでに並んだ変化。食べ終わってから読む */
  result(): TimedMessage[] {
    return this.timeline;
  }
}
