/**
 * **ライブの時間の軸 (Clock)。放送の今へ寄せる** ([stream.md](../../../docs/stream.md#ライブと追っかけの画面))。
 *
 * どれだけ貯めるか (`target`) と、その下限 (`floor`) を、詰まり・届く間隔・バッファの低いところから決め直す
 * (`ts/pacing.ts` の `nextTarget`・`pacing`)。追っかけはこれを使わない (今を追わない。`clock-chase.svelte.ts`)。
 * 再生位置を動かすのは再生の核 (`player/core.svelte.ts`) で、ここは測った値を持って決めるだけ (DOM に触らない)
 */

import { forget as forgetKey, read, write } from "#lib/keep.js";
import { onWebKit } from "#lib/native-audio-choice.js";
import {
  CEILING,
  cover,
  Extreme,
  FLOOR,
  GAP_MOST,
  GAP_WINDOW,
  nextTarget,
  SMOOTH,
  STEADY,
  type Steering,
} from "#lib/ts/pacing.js";

/** 貯める量を決め直す間隔 (ms)。塊は毎秒 20 個来るので、そのたびには回さない */
const SETTLE_EVERY = 5_000;
/**
 * バッファの低いところを見る長さ (秒。`pacing` の `low`)。**次の塊が届く直前のバッファを捉える。**
 *
 * まとめて届く経路では、塊は 0.3〜0.5 秒おきに束で来る。束の先頭の直前がいちばん低く、
 * 束の残りは届くたびに高く見える。何回ぶんかの束を収める長さにする
 */
const LOW_SPAN = 2;

/**
 * 覚えておく「これより下へは貯めない量」の置き場 (`ts/pacing` の `nextTarget`)。端末ごとに覚える。
 * 経路の性質なので、宅内の PC と出先のタブレットで違う。開くたびに `FLOOR` から始めていた頃は、
 * 開いて 30 秒以内に必ず 1 回止まっていた
 */
const FLOOR_KEY = "live-floor";

function storedFloor(): number {
  // localStorage が読めないとき (プライベートウィンドウなど) は下限から始める (`keep.read`)
  const saved = Number(read(FLOOR_KEY));
  if (!Number.isFinite(saved)) return FLOOR;
  return Math.min(CEILING, Math.max(FLOOR, saved));
}

/**
 * 速さの寄せ方 (`ts/pacing.ts` の `Steering`)。**Safari (Apple の WebKit) だけ、速さを触る回数を減らす** (`STEADY`)。
 * iPad と iPhone はどのブラウザも中身が WebKit なので、ここに入る。見分け方は UA (`native-audio-choice.ts` の `onWebKit`)。
 * ほかのブラウザも、画面が隠れている間は `STEADY` にする (`steeringWhen`)
 */
function chooseSteering(): Steering {
  return onWebKit() ? STEADY : SMOOTH;
}

export class LiveClock {
  /** 縮めるときの行き先の下限 (秒。`nextTarget`)。選局しても開き直しても持ち越す (経路の性質。`FLOOR_KEY`) */
  floor = $state(FLOOR);
  /** どれだけ貯めているか (秒)。詰まると伸び、無事が続くと縮む。始まりは下限と同じで、あとは別々に動く */
  target = $state(FLOOR);
  /** 画面に出す、いちばん長く空いた間隔 (秒)。**不具合の報告に要る** */
  gapMost = $state(0);
  /** 速さの寄せ方 (`chooseSteering`) */
  readonly steering = chooseSteering();
  /** 最後に詰まった時刻。無事が続いたかを見る */
  private lastStall = 0;
  /** 前回 `nextTarget` を回してから詰まったか */
  private stalled = false;
  /** 最後に `nextTarget` を回した時刻 */
  private lastSettled = 0;
  /** 下限を最後に動かした時刻。**下げ直すのはゆっくり** (`pacing` の `FORGET`) */
  private lastFloor = 0;
  /**
   * 映像の塊が届く間隔のうち、ここ数分でいちばん長いもの (`pacing` の `cover`)。
   * **止まる前から、空く間隔を覆えるだけ貯める** (#1210)。時刻は秒 (`performance.now`)
   */
  private readonly gaps = new Extreme(GAP_WINDOW, true);
  /** 最後に塊が届いた時刻 (秒)。0 なら次の 1 つは間隔に数えない (選局した直後・止めている間) */
  private lastArrival = 0;
  /** ここしばらくのバッファの低いところ (`pacing` の `low`)。時刻は秒 */
  private readonly lows = new Extreme(LOW_SPAN, false);
  /** ここ数秒の届く間隔のいちばん長いもの (`pacing` の `dip`)。時刻は秒 */
  private readonly dips = new Extreme(LOW_SPAN, true);

  constructor() {
    const initial = storedFloor();
    this.floor = initial;
    this.target = initial;
  }

  /** いま効いている下限 (秒)。覚えた下限と、届く間隔を覆う高さ (`cover`) の高いほう */
  get effectiveFloor(): number {
    return Math.max(this.floor, cover(this.gapMost));
  }

  /** 放送の今に張り付いているか。少しの揺れでは離れたことにしない。`behind` はいま先に持っている長さ (秒) */
  atLive(behind: number): boolean {
    return behind <= this.target + 1.5;
  }

  /** いまのバッファ (秒) を、低いところの候補として覚える。**届く直前と、映した 1 枚ごとに** (ライブで再生しているときだけ) */
  sampleLow(ahead: number): void {
    this.lows.push(performance.now() / 1000, ahead);
  }

  /** ここしばらくのバッファの低いところ (秒)。まだ無ければ null */
  low(): number | null {
    return this.lows.peek(performance.now() / 1000);
  }

  /** 飛んだ。前の位置のバッファの低いところは当てにならない */
  clearLows(): void {
    this.lows.clear();
  }

  /**
   * 映像の塊が届いた。**前の塊との間隔を覚える** (`gaps`)。`counting` は、ライブを再生していて、止めておらず、
   * 画面が見えているか。隠れているタブは届き方も描き方も絞られるので、混ぜると間隔が長く見える
   */
  arrive(counting: boolean): void {
    const now = performance.now() / 1000;
    if (counting && this.lastArrival > 0) {
      const gap = now - this.lastArrival;
      // 長すぎる空きは途絶え (`GAP_MOST`)。覆いにいかない
      if (gap <= GAP_MOST) {
        this.gaps.push(now, gap);
        this.dips.push(now, gap);
      }
    }
    this.lastArrival = counting ? now : 0;
  }

  /** 届く間隔とバッファの低いところを忘れる。**選局したとき・飛んだとき** (前の局・前の位置の値は当てにならない) */
  forgetFlow(): void {
    this.lows.clear();
    this.dips.clear();
    this.lastArrival = 0;
  }

  /**
   * いま覆うべき空き (秒)。覚えている間隔と、**いま空いている最中の間隔**の長いほう。
   * 詰まりはたいてい空きの途中で起きるので、届くのを待たずに数える
   */
  gapNow(): number {
    const now = performance.now() / 1000;
    const ongoing =
      this.lastArrival > 0 ? Math.min(GAP_MOST, now - this.lastArrival) : 0;
    return Math.max(this.gaps.peek(now) ?? 0, ongoing);
  }

  /**
   * バッファの低いところに足す量 (`pacing` の `dip`)。ここ数秒の届く間隔と、**いま空いている最中の間隔**の長いほう。
   * 覆えている空きの途中で「足りない」と見て遅くしない (遅くするのは本当に足りないときだけ)。
   * 空いている最中の間隔は、覚えている間隔 (`gaps`) までしか足さない。それより長く空いたら、遅くして持たせにいく
   */
  dipNow(): number {
    const now = performance.now() / 1000;
    const ongoing =
      this.lastArrival > 0
        ? Math.min(this.gaps.peek(now) ?? 0, now - this.lastArrival)
        : 0;
    return Math.max(this.dips.peek(now) ?? 0, ongoing);
  }

  /** 詰まった (自分で飛んだぶんと止めているときは、呼ぶ側が数えない) */
  stall(): void {
    this.stalled = true;
    this.lastStall = Date.now();
  }

  /** 貯める量を決め直す頃か (`SETTLE_EVERY` ごと。詰まったらすぐ)。決め直す頃なら、前回から詰まったかを返す */
  due(now: number): { stalled: boolean } | null {
    if (!this.stalled && now - this.lastSettled < SETTLE_EVERY) return null;
    return { stalled: this.stalled };
  }

  /** 貯める量を決め直す。**止まったら伸ばし、無事が続いたら縮める** (`due` が返したときに呼ぶ) */
  settle(now: number): void {
    const gap = this.gapNow();
    const most = Math.round(gap * 100) / 100;
    if (most !== this.gapMost) this.gapMost = most;
    const next = nextTarget(
      { target: this.target, floor: this.floor },
      this.stalled,
      (now - this.lastStall) / 1000,
      (now - this.lastFloor) / 1000,
      gap,
    );
    this.stalled = false;
    this.lastSettled = now;
    if (next.floor !== this.floor) {
      this.floor = next.floor;
      this.lastFloor = now;
      // 次に開いたときはここから始める。探し直しは経路が変わったときだけ
      write(FLOOR_KEY, String(this.floor));
    }
    if (next.target !== this.target) this.target = next.target;
  }

  /**
   * 覚えた下限を捨てて測り直す (経路が変わったときの出口)。高すぎる側に外れると 10 分ごとに 0.3 秒ずつしか
   * 下がらない (`nextTarget` の `FORGET`)。まっさらな端末と同じ状態に戻す。届く間隔も前の経路のものなので忘れる
   */
  relearn(): void {
    forgetKey(FLOOR_KEY);
    this.floor = FLOOR;
    this.lastFloor = Date.now();
    this.target = FLOOR;
    this.gaps.clear();
    this.gapMost = 0;
    this.forgetFlow();
  }
}
