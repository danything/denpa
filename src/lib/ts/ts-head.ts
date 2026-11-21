/**
 * **TS の先頭 (再生位置 0 の手前) の放送時刻を測る** (サーバ専用)。
 *
 * 録画の先頭は番組の始まり (`start_at`) ではない。前のマージン (`START_MARGIN`) のぶん早く、
 * 予約の定期チェック (5 秒おき) とチューナーを開くぶん遅れ、取り合いで先頭を譲れば
 * (`record_from`) 何分もずれる。DB の予定から推すとこれらがそのままずれになるので、
 * **TS そのものから測る。** 最初の TDT の時刻から、そこまでに PCR が進んだぶんを引く。
 * PCR は映像の時刻と同じ時計なので、ffmpeg が数える「入れ物の先頭からの秒」と揃う
 * (ffmpeg の先頭は最初の PTS で、最初の PCR より 1 秒足らず後。そのぶん遅れて出るが、
 * データ放送も実況のコメントも秒単位で動くので効かない)。
 *
 * TDT は局ごとに −0.72〜+0.90 秒ずれている (`clock.ts`) が、使いみちには十分。
 * 使うのは録画のデータ放送 (`data-capture.ts`) と、録っている間に `recordings.ts_head` を書く
 * `server/recorder.ts`
 */

import { parseTimeTable, PID_TIME } from "@danything/arib/eit";
import { PacketStream, SectionAssembler } from "@danything/arib/psi";

import { type Anchor, BroadcastClock, PCR_WRAP } from "./clock";

export class TsHead {
  private readonly packets = new PacketStream();
  /** PCR を読む (1 局に絞ってあるので、PMT に書いてある PID のもの) */
  private readonly clock = new BroadcastClock();
  // TDT は CRC を持たない (`bml.ts` と同じ受け方)
  private readonly time = new SectionAssembler(PID_TIME, "syntax");
  /** ファイルで最初に読めた PCR (秒) */
  private firstPcr = Number.NaN;
  private headAt: number | null = null;

  /** 先頭の放送時刻 (unix ms)。TDT をまだ一度も見ていなければ null */
  get head(): number | null {
    return this.headAt;
  }

  /**
   * 先頭の PCR と放送時刻の組。**PCR の時計の値を放送時刻に直す** (`clock.ts` の `stcUnixMs`。録画のデータ放送の NPT 参照)。
   * 先頭をまだ測れていなければ null
   */
  get anchor(): Anchor | null {
    return this.headAt === null || Number.isNaN(this.firstPcr)
      ? null
      : { pcr: this.firstPcr, unixMs: this.headAt };
  }

  /** TS のチャンクを渡す (パケットの切れ目は気にしなくてよい) */
  feed(chunk: Uint8Array): void {
    for (const packet of this.packets.feed(chunk)) this.feedPacket(packet);
  }

  /**
   * 切り分け済みのパケットを 1 つ。測れたあとは何もしない。PCR より先に TDT が来たときだけ、最初の PCR を読むまで続ける
   * (先頭の時刻は TDT のところで決まり、`anchor` は最初の PCR をその時刻とみなす。PCR は 0.1 秒おきに来るので、ずれはその内に収まる)
   */
  feedPacket(packet: Uint8Array): void {
    if (this.headAt !== null && !Number.isNaN(this.firstPcr)) return;
    // 時計を先に進める。同じパケットで TDT が揃ったときに、そこまでの PCR で先頭を測る
    this.clock.feedPacket(packet, 0);
    if (Number.isNaN(this.firstPcr)) this.firstPcr = this.clock.now;
    if (this.headAt !== null) return;
    for (const section of this.time.feed(packet)) {
      const at = parseTimeTable(section);
      if (at === null) continue;
      this.headAt = Math.round(at - this.sinceHead() * 1000);
      return;
    }
  }

  /** ファイルの先頭から、いま読んでいるところまでに PCR が進んだ秒。まだ読めていなければ 0 */
  private sinceHead(): number {
    const now = this.clock.now;
    if (!Number.isFinite(this.firstPcr) || !Number.isFinite(now)) return 0;
    return (((now - this.firstPcr) % PCR_WRAP) + PCR_WRAP) % PCR_WRAP;
  }
}
