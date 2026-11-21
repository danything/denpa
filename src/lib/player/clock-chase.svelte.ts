/**
 * **追っかけの時間の軸 (Clock)。放送の今を追わない** ([issue #16](https://github.com/danything/denpa/issues/16)。
 * [stream.md](../../../docs/stream.md#ライブと追っかけの画面))。
 *
 * 観ている録画と、**いまの ffmpeg が 0 と数える位置** (`base` 秒) を持つ。シークで再エンコードするたびに `base` が変わり、
 * 画面に見せる位置は `base` + 再生位置。右端は「録れているところ」で、サーバが倍速で送り込む (`server/chase.ts`)。
 * 元の TS で受けるときは、受信バッファが溜まったらサーバに送るのを止めさせる (`hold`)。
 * 再生位置を動かすのは再生の核 (`player/core.svelte.ts`) で、ここは位置の読み替えと止めさせる時機を決める (DOM に触らない)
 */

import { holdStep, rawChasePosition } from "#lib/live-chase.js";
import type { BroadcastCodec } from "#lib/live-choice.js";

/**
 * 刈るときに再生位置の後ろへ残す幅 (秒)。**追っかけはいま出している所の後ろを捨てない** (受け取るほうを止める)。
 * ちょうどで切ると、出している最中のところを取り上げることになる
 */
const BEHIND = 2;

/** 追っかけの物差し (`timeline` の通知)。録画中は右端を壁時計で伸ばして読む */
export interface ChaseTimeline {
  recordedSec: number;
  totalSec: number;
  finished: boolean;
  since: number;
}

export class ChaseClock {
  readonly recordingId: number;
  /** いまの ffmpeg が 0 と数える位置 (秒)。サーバが決めた実際の開始位置に合わせ直す (`timeline`) */
  base = $state(0);
  /** 録画の放送のコーデック (4K の局の録画 `.mmts` は `hevc`) */
  broadcast = $state<BroadcastCodec>("mpeg2");
  /** 追っかけの物差し。届くまでは null */
  timeline = $state<ChaseTimeline | null>(null);
  /** 録れているところまで読み切ったか */
  ended = $state(false);
  /** 録れているところまで鳴らしきったか (canvas で描くとき。`RawEvents.ended`)。押しても再開しない */
  drained = false;
  /**
   * 元の TS で受けるときの物差しの 0 (録画の先頭の PTS。`timeline` の `origin`)。届いていなければ null で、
   * そのときは鳴らし始めた PTS を `base` の位置とみなす (`rawHead`)
   */
  private origin: number | null = null;
  /** `origin` が無いとき、リクエストし直してから最初に鳴った位置 (秒。PTS のまま) */
  private rawHead: number | null = null;
  /** サーバに送るのを止めさせているか (`{ type: 'hold' }`。元の TS で受けているときだけ) */
  private feedHeld = false;

  constructor(recordingId: number, base: number, broadcast: BroadcastCodec) {
    this.recordingId = recordingId;
    this.base = Math.max(0, base);
    this.broadcast = broadcast;
  }

  /** 再エンコードし直す (シーク・繋ぎ直し)。読み切りの印と、元の TS の物差しは届き直す */
  reopen(base: number): void {
    this.base = Math.max(0, base);
    this.ended = false;
    this.drained = false;
    this.rested();
  }

  /** サーバは新しい指示で送るのを止めた印を戻す (`server/live.ts` の `attend`)。物差しの 0 も届き直す */
  rested(): void {
    this.feedHeld = false;
    this.origin = null;
    this.rawHead = null;
  }

  /** 物差しが届いた (`timeline`)。**base はサーバが決めた実際の開始位置に合わせ直す** (録れている範囲に収められることがある) */
  learn(at: number, origin: number | null, timeline: ChaseTimeline): void {
    this.base = at;
    this.origin = origin;
    this.timeline = timeline;
  }

  /** 通しの位置 (秒)。`local` は再エンコードの先頭からの位置 */
  at(local: number): number {
    return this.base + local;
  }

  /**
   * 元の TS で受けているときの再生位置 (`base` からの秒)。PTS は放送の時刻のままなので、録画の先頭の PTS
   * (`origin`) を引いて通しの位置を出す (観る画面の MPEG-2 と同じ `sinceHead`)。バイト数から割り出した `base`
   * より正しい。`origin` が無ければ、鳴らし始めた位置を `base` とみなす
   */
  rawAt(pts: number): number {
    if (this.origin !== null)
      return rawChasePosition(pts, this.base, this.origin);
    this.rawHead ??= pts;
    return pts - this.rawHead;
  }

  /**
   * 元の TS で受けているとき、**サーバに送るのを止めさせる・続けさせる** (`live-chase.ts` の `holdStep`)。
   * サーバは倍速で送り込み、元の TS は捨てられない (捨てると観ていない先が欠ける) ので、受信バッファが溜まったら止めさせる。
   * 一時停止している間も止めさせる。**送れたときだけ覚える。** 繋ぎ直している間に送れなかったぶんは、繋がってから送り直す
   */
  hold(lead: number, paused: boolean, send: (on: boolean) => boolean): void {
    this.feedHeld = holdStep(this.feedHeld, lead, paused, send);
  }

  /** ここより前は捨ててよい (秒)。`want` (戻れる幅より前) のうち、いま出している所 `at` の `BEHIND` 秒前より後ろは捨てない */
  keepFrom(want: number, at: number): number {
    return Math.min(want, at - BEHIND);
  }
}
