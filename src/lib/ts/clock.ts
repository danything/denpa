/**
 * **放送の時計 (PCR) を、受け取った時刻と映像の物差しに結びつける。**
 *
 * **手元のバッファの差** (`buffered.end - currentTime`) は「あと何秒ぶん持っているか」で
 * あって、放送との差ではない。チューナーの選局から ffmpeg のエンコードの完了、
 * 回線まで、**上流でかかった時間はどれも入っていない**。
 *
 * 放送は PCR という時計を運んでいて、映像の PTS も同じ時計で打たれている。
 * PCR を「サーバが受け取った時刻」と組にしておけば、「いま映しているコマは、
 * 隣に置いたテレビなら何時何分に映るものか」が言える。
 *
 *     受け取った時刻(unixMs, サーバの時計) ─── そのとき着いた PCR (90 kHz)
 *
 * ffmpeg は入力の時刻を 0 に寄せて出すので (`-copyts` を付けていない。理由は
 * `server/live.ts`)、エンコードしたものの物差しに直すには**寄せたぶんを引く**だけでよい。
 * 引く量は ffmpeg 自身が入力の情報に出力する (`Input #0 ... start: 72575.147089`)。
 * 出力でも同じだけしか寄っていないことは実測で確かめてある (docs/stream.md)。
 *
 * **PCR は 26.5 時間で一周する** (33 ビット)。またいだら結びつけ直すだけにしてある。
 * 巻き戻ったように見えたぶんを足し込む作りにすると、選局直後の飛びまで取り込んで
 * **時刻が何時間もずれる**おそれがある。
 *
 * ## 放送の時刻 (TDT/TOT) は使わない
 *
 * **TDT は局ごとに固定でずれている。** 受け取った時刻 (NTP で合わせたサーバの時計) と
 * 突き合わせると、11 局で -0.72〜+0.90 秒 (テレ東 -0.41、tvk +0.90、フジ -0.72)。
 * 秒未満の端数も局ごとに同じところで入ってくるので、何本待っても寄らない。TDT と組にすると、
 * その差がそのまま「放送から」に出て、E テレでは手元のバッファより小さい値になる。
 *
 * 比べる相手 (`now`) もサーバの時計なので、**時計の絶対値はどこにも要らない**。
 *
 * ## いちばん早く着いた組を採る
 *
 * 受け取るのはチャンクごとで、ffmpeg が詰まれば読むのも遅れる。遅れた組を採ると
 * そのぶん「放送から」が小さく出るので、**`受け取った時刻 − PCR` がいちばん
 * 小さい組**を採る。ただし PCR とサーバの時計は別の水晶なので少しずつずれる。
 * 組は永久には持たず、**30 秒ごとに選び直す** (直前の区切りのぶんも残して比べる)
 */

import { CLOCK, pcrBase, WRAP as PTS_WRAP } from "@danything/arib/pes";
import {
  packetPid,
  PacketStream,
  pmtPcrPid,
  PmtTracker,
  TABLE_PMT,
} from "@danything/arib/psi";

/** 33 ビットで一周する長さ (秒)。26.5 時間ほど */
export const PCR_WRAP = PTS_WRAP / CLOCK;
/** 組を選び直す区切り (ms)。水晶どうしのずれは 30 秒で 1 ms にも届かない */
const WINDOW = 30_000;

/** 受け取った時刻と、そのとき着いた PCR */
export interface Anchor {
  /** そのとき着いた PCR (秒) */
  pcr: number;
  /** サーバが受け取った時刻 (unix ms) */
  unixMs: number;
}

/**
 * 1 パケットから PCR を読む (秒。基準部だけ。`pcrBase`)。無ければ NaN
 */
export function readPcr(packet: Uint8Array): number {
  const base = pcrBase(packet);
  return base === null ? Number.NaN : base / CLOCK;
}

/** `受け取った時刻 − PCR` (秒)。**小さいほど遅れずに着いた組** */
function lag(anchor: Anchor): number {
  return anchor.unixMs / 1000 - anchor.pcr;
}

/**
 * 1 局に絞った TS から、PCR と受け取った時刻の組を集め続ける。
 *
 * **絞ったあとを渡す** (`ServiceFilter` の出力)。あちらは PAT・PMT と
 * その局の ES を残すので、PCR を運ぶ ES も通っている
 */
export class BroadcastClock {
  private readonly packets = new PacketStream();
  /** 絞ったあとなので番組は 1 つだけ。最初のものを見る */
  private readonly pmt = new PmtTracker();
  private pcrPid: number | null = null;
  private pcr = Number.NaN;
  /** いまの区切りで採っている組 */
  private current: Anchor | null = null;
  /** 1 つ前の区切りで採った組。**区切りの直後に遅れた組しか無くても、遅れの小さい組を使えるように** */
  private previous: Anchor | null = null;
  private windowFrom = Number.NaN;

  /** いちばん遅れずに着いた組。まだ PCR を読めていなければ null */
  get anchor(): Anchor | null {
    const current = this.current;
    const previous = this.previous;
    if (current === null || previous === null) return current ?? previous;
    return lag(previous) < lag(current) ? previous : current;
  }

  /** 直近の PCR (秒)。まだ読めていなければ NaN */
  get now(): number {
    return this.pcr;
  }

  /**
   * @param receivedAt そのチャンクを受け取った時刻 (unix ms, サーバの時計)。
   *   チャンクの中の PCR はどれもこの時刻で組にする。早く着いた PCR ほど遅れて
   *   見えるだけで、チャンクの最後の PCR がいちばん小さく出て選ばれる
   */
  feed(chunk: Uint8Array, receivedAt = Date.now()): void {
    for (const packet of this.packets.feed(chunk))
      this.feedPacket(packet, receivedAt);
  }

  /** 切り分け済みのパケットを 1 つ (`BmlDecoder.feedPacket` と同じ事情) */
  feedPacket(packet: Uint8Array, receivedAt: number): void {
    const pid = packetPid(packet);
    if (this.pcrPid === null || pid === this.pcrPid) {
      const at = readPcr(packet);
      if (Number.isFinite(at)) this.onPcr(at, receivedAt);
    }
    for (const section of this.pmt.feed(packet, pid)) this.onPmt(section);
  }

  private onPcr(at: number, receivedAt: number): void {
    // 一周した (または選局で飛んだ)。結びつけ直す
    if (
      Number.isFinite(this.pcr) &&
      (at < this.pcr - 1 || at > this.pcr + PCR_WRAP / 2)
    ) {
      this.current = null;
      this.previous = null;
      this.windowFrom = Number.NaN;
    }
    this.pcr = at;
    if (!(receivedAt - this.windowFrom < WINDOW)) {
      this.previous = this.current;
      this.current = null;
      this.windowFrom = receivedAt;
    }
    const anchor = { pcr: at, unixMs: receivedAt };
    if (this.current === null || lag(anchor) < lag(this.current))
      this.current = anchor;
  }

  private onPmt(section: Uint8Array): void {
    if (section[0] !== TABLE_PMT || section.length < 12) return;
    this.pcrPid = pmtPcrPid(section);
  }
}

/**
 * ffmpeg が入力の情報に出力する `start:` を読む。
 *
 *     Duration: N/A, start: 72575.147089, bitrate: N/A
 *
 * **これが 0 に寄せたぶん**。`-copyts` を付けていないので、出てくる時刻は
 * 入力の時刻からこれを引いたものになる。映像が音声より遅れて始まっても
 * 映像だけ 0 に詰められることはない (先頭は同じフレームで埋まる。docs/stream.md)
 */
export function parseStart(line: string): number {
  const match = /\bstart:\s*(-?\d+(?:\.\d+)?)/.exec(line);
  return match === null ? Number.NaN : Number(match[1]);
}
