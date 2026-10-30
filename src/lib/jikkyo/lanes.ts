/**
 * **コメントを流す行の割り当て** (画面に触らない所。単体テストで見る)。
 *
 * - 行の高さは枠の高さの 1/14 (下限 14px)。上下に余白を残して、およそ 13 行
 * - 1 件は右の端から左の端まで `SPAN_MS` で流れる。長いものも同じ速さで、そのぶん長く流れる
 *   (速さが揃っているので、後から入ったものが前のものに追いつくことはない)
 * - 行が空くのは、前のコメントの尻尾が右の端から入りきったとき。**空いた行が無ければ捨てる** (重ねて描かない)
 * - 上・下に止めるもの (`ue`・`shita`) は `HOLD_MS` 置く。流れるものとは別に、上 (下) の行から空いたところへ積む
 *
 * 時刻はどれも**放送時刻の ms** で数える (再生の速さに合わせて進み、止めれば止まる)。
 * 画面の時計で数えると、止めている間に行が空いたことになってしまう
 */

/** 右の端から左の端まで (放送時刻の ms) */
export const SPAN_MS = 4_000;
/** 上・下に止めるもの (と、動きを減らす設定のときの流れるもの) を置いておく長さ */
export const HOLD_MS = 3_000;
/** 行の高さの下限 (px) */
const MIN_LINE = 14;
/** 前のコメントとの間に空ける幅 (字の大きさに対して) */
const GAP_EM = 1;

/** 行の高さ (px) */
export function lineHeight(frameHeight: number): number {
  return Math.max(MIN_LINE, frameHeight / 14);
}

/** 行の数。上下に半行ずつ余白を残す */
export function laneCount(frameHeight: number): number {
  return Math.max(1, Math.floor(frameHeight / lineHeight(frameHeight)) - 1);
}

/** 字の大きさ (px)。行の高さに収まる大きさ */
export function fontSize(frameHeight: number): number {
  return Math.round(lineHeight(frameHeight) * 0.8);
}

/**
 * 字の幅のあたり (px)。画面を測らずに決める (流すたびにレイアウトを読むと重い)。
 * 半角の英数字は字の大きさの 0.55 倍、ほかは 1 倍とみなす
 */
export function textWidth(text: string, size: number): number {
  let em = 0;
  for (const char of text) em += /[ -~｡-ﾟ]/.test(char) ? 0.55 : 1;
  return em * size;
}

/** 1 件の流し方 */
export interface Flow {
  lane: number;
  /** 流れ終わるまで (放送時刻の ms)。画面の CSS の長さは、これを再生の速さで割ったもの */
  duration: number;
}

export class Lanes {
  /** 行ごとの、次のコメントを入れてよい時刻 */
  private freeAt: number[];
  /** 行ごとの、次の止めるものを置いてよい時刻 */
  private heldAt: number[];

  constructor(count: number) {
    this.freeAt = Array.from({ length: count }, () => Number.NEGATIVE_INFINITY);
    this.heldAt = [...this.freeAt];
  }

  get count(): number {
    return this.freeAt.length;
  }

  /** 枠の大きさが変わった。行の数を合わせる (流れているものの印はそのまま) */
  resize(count: number): void {
    if (count === this.freeAt.length) return;
    this.freeAt = Array.from(
      { length: count },
      (_, i) => this.freeAt[i] ?? Number.NEGATIVE_INFINITY,
    );
    this.heldAt = Array.from(
      { length: count },
      (_, i) => this.heldAt[i] ?? Number.NEGATIVE_INFINITY,
    );
  }

  /** 飛んだ (シーク・局の切り替え)。どの行も空ける */
  clear(): void {
    this.freeAt.fill(Number.NEGATIVE_INFINITY);
    this.heldAt.fill(Number.NEGATIVE_INFINITY);
  }

  /**
   * 右から左へ流す行を決める。空いた行が無ければ null (捨てる)。
   * @param now いまの放送時刻 (ms)
   * @param width コメントの幅 (px)
   * @param frameWidth 枠の幅 (px)
   * @param size 字の大きさ (px)
   */
  flow(
    now: number,
    width: number,
    frameWidth: number,
    size: number,
  ): Flow | null {
    const speed = frameWidth / SPAN_MS;
    if (!(speed > 0)) return null;
    const lane = this.freeAt.findIndex((at) => at <= now);
    if (lane < 0) return null;
    this.freeAt[lane] = now + (width + size * GAP_EM) / speed;
    return { lane, duration: (frameWidth + width) / speed };
  }

  /**
   * 上か下に止める (`ue`・`shita`。動きを減らす設定のときは流れるものも上に)。`from` の端の行から空いたところに
   * `HOLD_MS` 置く。返す行はいつも上から数えたもの
   */
  hold(now: number, from: "top" | "bottom"): Flow | null {
    const count = this.heldAt.length;
    for (let i = 0; i < count; i++) {
      const lane = from === "top" ? i : count - 1 - i;
      if (this.heldAt[lane]! > now) continue;
      this.heldAt[lane] = now + HOLD_MS;
      return { lane, duration: HOLD_MS };
    }
    return null;
  }
}

/**
 * 字の大きさの倍率 (`big`・`small`)。大きいものも 1 行に収まる所まで (字は行の高さの 0.8 なので 1.25 倍で行いっぱい)。
 * 行をまたいで積まない
 */
export function sizeScale(size: "big" | "small" | undefined): number {
  return size === "big" ? 1.25 : size === "small" ? 0.75 : 1;
}
