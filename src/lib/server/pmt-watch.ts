/**
 * **1 局に絞った TS から PMT だけを読み、そこから決めた値を持つ。** カルーセルや映像はデコードしない。
 *
 * データ放送の自動起動の指定 (`databroadcast.ts` の `AutoStartWatch`) と、選べる音声の部品タグ (`live.ts` の `PmtAudioWatch`) が使う。
 * PMT は 100ms ごとに来る数百バイトなので、誰もリクエストしていなくても読み続けて安い
 */

import { packetPid, PID_PAT, PmtTracker, TABLE_PMT } from "@danything/arib/psi";

export class PmtWatch<T> {
  private readonly pmt: PmtTracker;
  /** 最後に読んだ PMT で決めた値。読むまでは null */
  private now: T | null = null;

  /**
   * @param program 放送が名乗っている番号 (program_number)
   * @param read PMT のセクション 1 つから値を決める
   */
  constructor(
    program: number,
    private readonly read: (section: Uint8Array) => T,
  ) {
    this.pmt = new PmtTracker(program);
  }

  /** 決めた値。PMT を読むまでは null */
  get value(): T | null {
    return this.now;
  }

  /** 1 局に絞った TS のパケットを 1 つ。**決めた値が初めて決まったか変わったら true** */
  feedPacket(packet: Uint8Array): boolean {
    const pid = packetPid(packet);
    if (pid !== PID_PAT && pid !== this.pmt.pid) return false;
    let changed = false;
    for (const section of this.pmt.feed(packet, pid)) {
      if (section[0] !== TABLE_PMT) continue;
      const next = this.read(section);
      if (JSON.stringify(next) === JSON.stringify(this.now)) continue;
      this.now = next;
      changed = true;
    }
    return changed;
  }
}
