/**
 * **コメントを流す行の割り当て** (画面に触らない所。単体テストで見る)。流し方はニコニコと同じにする。
 *
 * - 行の高さは枠の高さの 1/14 (下限 14px)。上下に余白を残して、およそ 13 行
 * - **1 件は、先頭が枠の右の端に着いてから末尾が左の端を出るまで、どれも `SPAN_MS` で渡る。** 長いものほど速く流れる
 *   (速さは `(枠の幅 + コメントの幅) / SPAN_MS`。`speedOf`)
 * - アンビエントの光を出している間は、枠の外 (`Outside`) もそのコメントの速さのまま流れる。道のりが延びるだけで、枠を渡る長さは変わらない
 * - 行が空くのは、前のコメントの末尾が枠の右の端を過ぎてから次のものの先頭がそこへ着き、
 *   しかも次のもののほうが速くても、前のものの末尾が左の端 (外があれば外の左の端) を出るまで追い付かないとき
 * - **空いた行が無ければ、どれかの行にくじで重ねて流す** (ニコニコの弾幕と同じ)。重ねたものは行の空きに数えない
 * - 上・下に止めるもの (`ue`・`shita`) は `HOLD_MS` 置く。流れるものとは別に、上 (下) の行から空いたところへ積み、
 *   空いた行が無ければくじで重ねる
 *
 * 時刻はどれも**放送時刻の ms** で数える (再生の速さに合わせて進み、止めれば止まる)。
 * 画面の時計で数えると、止めている間に行が空いたことになってしまう
 */

/** 先頭が枠の右の端に着いてから、末尾が左の端を出るまで (放送時刻の ms)。ニコニコと同じ 4 秒 */
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

/** 1 件の速さ (px / 放送時刻の ms)。どれも枠を `SPAN_MS` で渡りきるので、長いものほど速い */
export function speedOf(frameWidth: number, width: number): number {
  return (frameWidth + width) / SPAN_MS;
}

/**
 * 外の右の端から枠の右の端に着くまで (放送時刻の ms)。録画 (コメントが前もって分かる) は、コメントごとにこれだけ早く流し始め、
 * 枠に入る時刻を外が無いときと同じにする。`width` を 0 にすると、どのコメントよりも長い (先まで取る長さに使う)
 */
export function lead(frameWidth: number, width: number, right: number): number {
  const speed = speedOf(frameWidth, width);
  return frameWidth > 0 && speed > 0 ? right / speed : 0;
}

/** 1 件の流し方 */
interface Flow {
  lane: number;
  /** 流れ終わるまで (放送時刻の ms)。画面の CSS の長さは、これを再生の速さで割ったもの */
  duration: number;
}

export class Lanes {
  /** 行ごとの、前のコメントの末尾 (と間) が枠の右の端を過ぎる時刻。次のものの先頭がそこへ着くのはこれより後 */
  private entryAt: number[];
  /** 行ごとの、前のコメントの末尾 (と間) が左の端 (外があれば外の左の端) を出る時刻。次のものの先頭がそこへ着くのはこれより後 */
  private exitAt: number[];
  /** 行ごとの、次の止めるものを置いてよい時刻 */
  private heldAt: number[];

  /** @param random 重ねる行を選ぶくじ (0 以上 1 未満。テストでは決まった値を渡す) */
  constructor(
    count: number,
    private readonly random: () => number = Math.random,
  ) {
    this.entryAt = Array.from(
      { length: count },
      () => Number.NEGATIVE_INFINITY,
    );
    this.exitAt = [...this.entryAt];
    this.heldAt = [...this.entryAt];
  }

  get count(): number {
    return this.entryAt.length;
  }

  /** 枠の大きさが変わった。行の数を合わせる (流れているものの印はそのまま) */
  resize(count: number): void {
    if (count === this.entryAt.length) return;
    const fit = (marks: number[]) =>
      Array.from(
        { length: count },
        (_, i) => marks[i] ?? Number.NEGATIVE_INFINITY,
      );
    this.entryAt = fit(this.entryAt);
    this.exitAt = fit(this.exitAt);
    this.heldAt = fit(this.heldAt);
  }

  /** 飛んだ (シーク・局の切り替え)。どの行も空ける */
  clear(): void {
    this.entryAt.fill(Number.NEGATIVE_INFINITY);
    this.exitAt.fill(Number.NEGATIVE_INFINITY);
    this.heldAt.fill(Number.NEGATIVE_INFINITY);
  }

  /**
   * 右から左へ流す行を決める。空いた行が無ければ、くじで選んだ行に重ねる。枠の幅が 0 なら null (流さない)。
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
    const speed = speedOf(frameWidth, width);
    if (!(frameWidth > 0) || !(speed > 0)) return null;
    // 先頭が枠の右の端に着く時刻と、左の端 (外の左の端) に着く時刻
    const arrive = now + outside.right / speed;
    const reach = arrive + (frameWidth + outside.left) / speed;
    const duration =
      (outside.right + frameWidth + outside.left + width) / speed;
    const lane = this.entryAt.findIndex(
      (at, i) => at <= arrive && this.exitAt[i]! <= reach,
    );
    if (lane < 0) return { lane: this.pick(), duration };
    const tail = (width + size * GAP_EM) / speed;
    this.entryAt[lane] = arrive + tail;
    this.exitAt[lane] = reach + tail;
    return { lane, duration };
  }

  /**
   * 上か下に止める (`ue`・`shita`。動きを減らす設定のときは流れるものも上に)。`from` の端の行から空いたところに
   * `HOLD_MS` 置く。空いた行が無ければ、くじで選んだ行に重ねる。返す行はいつも上から数えたもの
   */
  hold(now: number, from: "top" | "bottom"): Flow {
    const count = this.heldAt.length;
    for (let i = 0; i < count; i++) {
      const lane = from === "top" ? i : count - 1 - i;
      if (this.heldAt[lane]! > now) continue;
      this.heldAt[lane] = now + HOLD_MS;
      return { lane, duration: HOLD_MS };
    }
    return { lane: this.pick(), duration: HOLD_MS };
  }

  /** 重ねる行。重ねたものは行の空きに数えない (数えると、空いた行まで埋まったことになる) */
  private pick(): number {
    return Math.min(
      this.entryAt.length - 1,
      Math.floor(this.random() * this.entryAt.length),
    );
  }
}

/**
 * 字の大きさの倍率 (`big`・`small`)。大きいものも 1 行に収まる所まで (字は行の高さの 0.8 なので 1.25 倍で行いっぱい)。
 * 行をまたいで積まない
 */
export function sizeScale(size: "big" | "small" | undefined): number {
  return size === "big" ? 1.25 : size === "small" ? 0.75 : 1;
}
