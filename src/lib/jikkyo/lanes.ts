/**
 * **コメントを流す行の割り当て** (画面に触らない所。単体テストで見る)。
 *
 * - 行の高さは枠の高さの 1/14 (下限 14px)。上下に余白を残して、およそ 13 行
 * - 1 件は枠の右の端から左の端まで `SPAN_MS` で流れる。長いものも同じ速さで、そのぶん長く流れる
 *   (速さが揃っているので、後から入ったものが前のものに追いつくことはない)
 * - アンビエントの光を出している間は、枠の外 (`Outside`) も同じ速さで流れる。道のりが延びるだけで、枠を渡る長さは変わらない
 * - 行が空くのは、前のコメントの尻尾が枠の右の端を過ぎてから、次のものの頭がそこへ着くとき。
 *   どちらも同じ速さなので、枠の外から入っても前のものに重ならない。**空いた行が無ければ捨てる** (重ねて描かない)
 * - 上・下に止めるもの (`ue`・`shita`) は `HOLD_MS` 置く。流れるものとは別に、上 (下) の行から空いたところへ積む
 *
 * 時刻はどれも**放送時刻の ms** で数える (再生の速さに合わせて進み、止めれば止まる)。
 * 画面の時計で数えると、止めている間に行が空いたことになってしまう
 */

/** 右の端から左の端まで (放送時刻の ms) */
export const SPAN_MS = 4_000;
/** 上・下に止めるもの (と、動きを減らす設定のときの流れるもの) を置いておく長さ */
const HOLD_MS = 3_000;
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

/** 枠の外を流れる幅 (px)。`right` は入ってくる側、`left` は出ていく側。光を出していなければどちらも 0 */
export interface Outside {
  right: number;
  left: number;
}

export const NO_OUTSIDE: Outside = { right: 0, left: 0 };

/**
 * 外の右の端から枠の右の端に着くまで (放送時刻の ms)。録画 (コメントが前もって分かる) はこれだけ早く流し始め、
 * 枠に入る時刻を外が無いときと同じにする
 */
export function lead(frameWidth: number, right: number): number {
  return frameWidth > 0 ? (right / frameWidth) * SPAN_MS : 0;
}

/** 1 件の流し方 */
interface Flow {
  lane: number;
  /** 流れ終わるまで (放送時刻の ms)。画面の CSS の長さは、これを再生の速さで割ったもの */
  duration: number;
}

export class Lanes {
  /** 行ごとの、前のコメントの尻尾 (と間) が枠の右の端を過ぎる時刻。次のものの頭がそこへ着くのはこれより後 */
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
   * @param outside 枠の外を流れる幅。外の右の端から入り、外の左の端から出ていく
   */
  flow(
    now: number,
    width: number,
    frameWidth: number,
    size: number,
    outside: Outside = NO_OUTSIDE,
  ): Flow | null {
    const speed = frameWidth / SPAN_MS;
    if (!(speed > 0)) return null;
    // 頭が枠の右の端に着く時刻
    const arrive = now + outside.right / speed;
    const lane = this.freeAt.findIndex((at) => at <= arrive);
    if (lane < 0) return null;
    this.freeAt[lane] = arrive + (width + size * GAP_EM) / speed;
    return {
      lane,
      duration: (outside.right + frameWidth + outside.left + width) / speed,
    };
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
