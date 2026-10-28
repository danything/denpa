/**
 * **コメントを流す行の割り当て** (画面に触らない所。単体テストで見る)。
 *
 * - 行の高さは枠の高さの 1/14 (下限 14px)。上下に余白を残して、およそ 13 行
 * - 1 件は右の端から左の端まで `SPAN_MS` で流れる。長いものも同じ速さで、そのぶん長く流れる
 *   (速さが揃っているので、後から入ったものが前のものに追いつくことはない)
 * - 行が空くのは、前のコメントの尻尾が右の端から入りきったとき。**空いた行が無ければ捨てる** (重ねて描かない)
 *
 * 時刻はどれも**放送時刻の ms** で数える (再生の速さに合わせて進み、止めれば止まる)。
 * 画面の時計で数えると、止めている間に行が空いたことになってしまう
 */

/** 右の端から左の端まで (放送時刻の ms) */
export const SPAN_MS = 4_000;
/** 動きを減らす設定のとき、上の行に置いておく長さ */
export const STILL_MS = 3_000;
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

  constructor(count: number) {
    this.freeAt = Array.from({ length: count }, () => Number.NEGATIVE_INFINITY);
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
  }

  /** 飛んだ (シーク・局の切り替え)。どの行も空ける */
  clear(): void {
    this.freeAt.fill(Number.NEGATIVE_INFINITY);
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

  /** 動きを減らす設定のとき。上の行から空いたところに `STILL_MS` 置く */
  still(now: number): Flow | null {
    const lane = this.freeAt.findIndex((at) => at <= now);
    if (lane < 0) return null;
    this.freeAt[lane] = now + STILL_MS;
    return { lane, duration: STILL_MS };
  }
}
