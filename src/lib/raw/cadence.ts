/**
 * **コマを出す間合い。** 何を描くかを「いま」ではなく「次に画面が切り替わる時刻」で決める。
 *
 * 60i の放送はフィールドごとに出す (bob) ので 59.94 回/秒、画面はたいてい 60 回/秒で、
 * ほぼ同じ間隔で並ぶ。worker は細かい時計 (4ms ごと) で刻み、1枚のデコードに 10〜20ms
 * かかるので、刻んだ時刻で「いまの番」を見ると、フィールドの切り替わりが画面の切り替わりの
 * 前後に揺れる。手前に来れば次の画面に出て、後ろへずれれば1回ぶん遅れる — 同じフィールドが
 * 2回出て、次のフィールドが飛ぶ。動いている映像ではこれがカクつきに見える。
 *
 * - 画面の切り替わり (`Vsync`): 画面の requestAnimationFrame の時刻から間隔と位置を覚え、
 *   次の切り替わりの時刻を出す。**同じ画面の切り替わりには、いつ刻んでも同じフィールドが選ばれる**
 * - 時計 (`SmoothClock`): 画面から 20ms ごとに届く「鳴っている PTS」の組は数 ms ずつ揺れる。
 *   そのまま差し替えると番が前後に飛ぶので、小さなずれは少しずつ寄せる。大きく飛んだ (シークした・
 *   貯め直した) ときだけ合わせ直す
 */

import { CLOCK } from "#lib/ts/pes.js";

/** 画面の切り替わりの間隔として受け取る幅 (ms)。240Hz〜20Hz */
const PERIOD_MIN = 4;
const PERIOD_MAX = 50;
/** 新しい間隔をどれだけ混ぜるか */
const PERIOD_GAIN = 0.1;
/** これより古い時刻しか無ければ当てにしない (裏に回って rAF が止まった) */
const STALE_MS = 1000;

/** 画面の切り替わり。時刻は `performance.timeOrigin + performance.now()` の ms */
export class Vsync {
  private anchor: number | null = null;
  private interval: number | null = null;

  /** requestAnimationFrame の時刻を1つ受け取る */
  feed(at: number): void {
    const last = this.anchor;
    this.anchor = at;
    if (last === null) return;
    const gap = at - last;
    // 裏から戻った (rAF が止まっていた) なら位置だけ覚え直す。長く空くと何回ぶんかの割り戻しがずれる
    if (gap <= 0 || gap > STALE_MS) return;
    // 落とした回 (2〜3回ぶん空いた) は、何回ぶんかで割って間隔に戻す
    const guess = this.interval ?? gap;
    const count = Math.max(1, Math.round(gap / guess));
    const one = gap / count;
    if (one < PERIOD_MIN || one > PERIOD_MAX) return;
    this.interval =
      this.interval === null
        ? one
        : this.interval + (one - this.interval) * PERIOD_GAIN;
  }

  /** 覚えている間隔 (ms)。まだ分からなければ null */
  get period(): number | null {
    return this.interval;
  }

  /** `at` より後で、いちばん近い切り替わりの時刻。分からない・古ければ null */
  next(at: number): number | null {
    if (
      this.anchor === null ||
      this.interval === null ||
      at - this.anchor > STALE_MS
    )
      return null;
    const count = Math.floor((at - this.anchor) / this.interval) + 1;
    return this.anchor + count * this.interval;
  }

  /**
   * **いまデコードを始めてよいか。** 切り替わりの直後 (間隔の前半) だけ。1枚のデコード (10〜20ms) は
   * 切り替わりを1つまたぐので、後半に始めると、その次の切り替わりに出すフィールドを描く前に
   * 回が延びる。切り替わりが分からなければいつでもよい
   */
  settled(at: number): boolean {
    const next = this.next(at);
    if (next === null || this.interval === null) return true;
    return next - at > this.interval * SETTLED;
  }

  clear(): void {
    this.anchor = null;
    this.interval = null;
  }
}

/** 切り替わりの間隔のうち、デコードを始めてよい前半の割合 (`settled`) */
const SETTLED = 0.5;

/** これより大きく食い違えば寄せずに合わせ直す (90kHz。50ms) */
const SNAP = 0.05 * CLOCK;
/** 届いた組へどれだけ寄せるか */
const CLOCK_GAIN = 0.1;

/** 鳴っている PTS の時計。`set` で届いた組を受け、`at` で任意の時刻の PTS を出す */
export class SmoothClock {
  private anchor: { pts: number; at: number } | null = null;

  /** 届いた組。**null は止まっている** */
  set(pts: number | null, at: number): void {
    if (pts === null) {
      this.anchor = null;
      return;
    }
    const predicted = this.at(at);
    if (predicted === null || Math.abs(pts - predicted) > SNAP) {
      this.anchor = { pts, at };
      return;
    }
    this.anchor = { pts: predicted + (pts - predicted) * CLOCK_GAIN, at };
  }

  /** `wall` (ms) の時点の PTS。止まっていれば null */
  at(wall: number): number | null {
    if (this.anchor === null) return null;
    return this.anchor.pts + (wall - this.anchor.at) * (CLOCK / 1000);
  }

  clear(): void {
    this.anchor = null;
  }
}

/** これより食い違えば合わせ直す (90kHz。8ms) */
const LOCK_SNAP = 0.008 * CLOCK;
/** 時計へどれだけ寄せるか (切り替わり1回ごと) */
const LOCK_GAIN = 0.01;

/**
 * **画面の切り替わりごとの PTS を、切り替わりの間隔ぶんずつ進める。** 時計は寄せてもなお 1ms 足らず
 * 揺れ、フィールドの切れ目が画面の切り替わりのすぐそばにある間 (59.94 と 60 の差で 16 秒ごとに来る)
 * は、その揺れで選ぶフィールドが行き来する (同じものが2回出て、次が飛ぶ)。切り替わりの時刻から
 * 決まる PTS を使い、時計へはごく少しずつ寄せる。大きく食い違えば (飛んだ・貯め直した) 合わせ直す
 */
export class VsyncClock {
  private last: { wall: number; pts: number } | null = null;

  /** 画面の切り替わり `wall` (ms) で出す PTS。`pts` は時計で読んだもの */
  pick(wall: number, pts: number): number {
    const last = this.last;
    let chosen = pts;
    if (last !== null) {
      const locked = last.pts + (wall - last.wall) * (CLOCK / 1000);
      if (Math.abs(pts - locked) <= LOCK_SNAP) {
        chosen =
          wall === last.wall ? last.pts : locked + (pts - locked) * LOCK_GAIN;
      }
    }
    this.last = { wall, pts: chosen };
    return chosen;
  }

  clear(): void {
    this.last = null;
  }
}

/** いま出しているコマ */
export interface Shown {
  pts: number;
  interlaced: boolean;
  topFirst: boolean;
}

/**
 * `at` (PTS) に出すフィールド。0 は上 (偶数行)、1 は下、-1 はプログレッシブ (そのまま)。
 * 後半 (`frame` の半分を過ぎた) は2枚目のフィールド
 */
export function fieldAt(shown: Shown, at: number, frame: number): number {
  if (!shown.interlaced) return -1;
  const second = at >= shown.pts + frame / 2;
  return shown.topFirst !== second ? 0 : 1;
}
