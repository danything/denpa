/**
 * **コメントを流す場所の割り当て** (画面に触らない所。単体テストで見る)。流し方はニコニコと同じにする。
 *
 * - **決まった行は持たない。** 1 件は字の高さぶん (`rows`。普通の大きさで 1) の縦の場所を取り、上から空いた所に積む。
 *   長さは行の高さを 1 とした単位で数える (枠の大きさが変わっても、位置はその割合のまま)
 *   - 行の高さは枠の高さの 1/14 (下限 14px)。上下に半行ずつ余白を残す。普通の大きさならおよそ 13 件が縦に並ぶ
 *   - 大きさの比もニコニコと同じ (`big` は 1.625 倍、`small` は 0.625 倍)。大きいものが多いと並ぶ数が減る
 * - **1 件は、先頭が枠の右の端に着いてから末尾が左の端を出るまで、どれも `SPAN_MS` で渡る。** 長いものほど速く流れる
 *   (速さは `(枠の幅 + コメントの幅) / SPAN_MS`。`speedOf`)
 * - アンビエントの光を出している間は、枠の外 (`Outside`) もそのコメントの速さのまま流れる。道のりが延びるだけで、枠を渡る長さは変わらない
 * - 縦に重なる前のものとは、前のものの末尾が枠の右の端を過ぎてから次のものの先頭がそこへ着き、
 *   しかも次のもののほうが速くても、前のものの末尾が左の端 (外があれば外の左の端) を出るまで追い付かないときだけ並べる
 * - **空いた所が無ければ、くじで選んだ高さに重ねて流す** (ニコニコの弾幕と同じ)。重ねたものは空きに数えない
 * - 上・下に止めるもの (`ue`・`shita`) は `HOLD_MS` 置く。流れるものとは別に、上 (下) の端から空いた所へ積み、
 *   空いた所が無ければくじで重ねる
 *
 * 時刻はどれも**放送時刻の ms** で数える (再生の速さに合わせて進み、止めれば止まる)。
 * 画面の時計で数えると、止めている間に場所が空いたことになってしまう
 */

/** 先頭が枠の右の端に着いてから、末尾が左の端を出るまで (放送時刻の ms)。ニコニコと同じ 4 秒 */
export const SPAN_MS = 4_000;
/** 上・下に止めるもの (と、動きを減らす設定のときの流れるもの) を置いておく長さ */
const HOLD_MS = 3_000;
/** 行の高さの下限 (px) */
const MIN_LINE = 14;
/** 前のコメントとの間に空ける幅 (字の大きさに対して) */
const GAP_EM = 1;
/** 上下に残す余白 (行の高さを 1 として) */
const MARGIN = 0.5;
/** 端数の誤差 (行の高さを 1 として)。ちょうど収まるものを収まらないとしない */
const EPSILON = 1e-6;

/** 行の高さ (px)。普通の大きさのコメント 1 件が取る高さ */
export function lineHeight(frameHeight: number): number {
  return Math.max(MIN_LINE, frameHeight / 14);
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

/** 1 件の置き方 */
interface Flow {
  /** 上の端 (枠の上から、行の高さを 1 として) */
  top: number;
  /** 流れ終わるまで (放送時刻の ms)。画面の CSS の長さは、これを再生の速さで割ったもの */
  duration: number;
}

/** 縦の場所 (行の高さを 1 として) */
interface Span {
  top: number;
  bottom: number;
}

/** 流れているもの */
interface Moving extends Span {
  /** 末尾 (と間) が枠の右の端を過ぎる時刻。縦に重なる次のものの先頭がそこへ着くのはこれより後 */
  entryAt: number;
  /** 末尾 (と間) が左の端 (外があれば外の左の端) を出る時刻。縦に重なる次のものの先頭がそこへ着くのはこれより後 */
  exitAt: number;
}

/** 止めているもの */
interface Held extends Span {
  /** 消す時刻 */
  until: number;
}

export class Lanes {
  private moving: Moving[] = [];
  private held: Held[] = [];

  /**
   * @param height 枠の高さ (行の高さを 1 として)
   * @param random 重ねる高さを選ぶくじ (0 以上 1 未満。テストでは決まった値を渡す)
   */
  constructor(
    private height = 1,
    private readonly random: () => number = Math.random,
  ) {}

  /** 枠の大きさが変わった (行の高さを 1 とした枠の高さ)。流れているものの場所はそのまま */
  resize(height: number): void {
    this.height = height;
  }

  /** 飛んだ (シーク・局の切り替え)。どこも空ける */
  clear(): void {
    this.moving = [];
    this.held = [];
  }

  /**
   * 右から左へ流す場所を決める。空いた所が無ければ、くじで選んだ高さに重ねる。枠の幅が 0 なら null (流さない)。
   * @param now いまの放送時刻 (ms)
   * @param width コメントの幅 (px)
   * @param frameWidth 枠の幅 (px)
   * @param size 字の大きさ (px)
   * @param rows コメントの高さ (行の高さを 1 として)
   * @param outside 枠の外を流れる幅。外の右の端から入り、外の左の端から出ていく
   */
  flow(
    now: number,
    width: number,
    frameWidth: number,
    size: number,
    rows = 1,
    outside: Outside = NO_OUTSIDE,
  ): Flow | null {
    const speed = speedOf(frameWidth, width);
    if (!(frameWidth > 0) || !(speed > 0)) return null;
    // 先頭が枠の右の端に着く時刻と、左の端 (外の左の端) に着く時刻
    const arrive = now + outside.right / speed;
    const reach = arrive + (frameWidth + outside.left) / speed;
    const duration =
      (outside.right + frameWidth + outside.left + width) / speed;
    // 左の端を出たものは、あとのどれとも重ならない
    this.moving = this.moving.filter((m) => m.exitAt > now);
    const busy = this.moving.filter(
      (m) => m.entryAt > arrive || m.exitAt > reach,
    );
    const top = this.stack(busy, rows, "top");
    if (top === null) return { top: this.draw(rows), duration };
    const tail = (width + size * GAP_EM) / speed;
    this.moving.push({
      top,
      bottom: top + rows,
      entryAt: arrive + tail,
      exitAt: reach + tail,
    });
    return { top, duration };
  }

  /**
   * 上か下に止める (`ue`・`shita`。動きを減らす設定のときは流れるものも上に)。`from` の端から空いた所に
   * `HOLD_MS` 置く。空いた所が無ければ、くじで選んだ高さに重ねる
   */
  hold(now: number, from: "top" | "bottom", rows = 1): Flow {
    this.held = this.held.filter((h) => h.until > now);
    const top = this.stack(this.held, rows, from);
    if (top === null) return { top: this.draw(rows), duration: HOLD_MS };
    this.held.push({ top, bottom: top + rows, until: now + HOLD_MS });
    return { top, duration: HOLD_MS };
  }

  /**
   * `from` の端から、`busy` のどれとも縦に重ならない最初の所 (ニコニコと同じ。重なったものの向こうの端へずらして探し直す)。
   * 余白の内に収まらなければ null
   */
  private stack(
    busy: readonly Span[],
    rows: number,
    from: "top" | "bottom",
  ): number | null {
    const lo = MARGIN;
    const hi = this.height - MARGIN;
    let y = from === "top" ? lo : hi - rows;
    for (;;) {
      const at = y;
      const hit = busy.find(
        (b) => b.top < at + rows - EPSILON && at < b.bottom - EPSILON,
      );
      if (hit === undefined) break;
      y = from === "top" ? hit.bottom : hit.top - rows;
    }
    return y >= lo - EPSILON && y + rows <= hi + EPSILON ? y : null;
  }

  /** 重ねる高さ。余白の内でくじを引く (収まらないほど大きいものは上の余白から) */
  private draw(rows: number): number {
    const room = this.height - 2 * MARGIN - rows;
    return MARGIN + Math.max(0, room) * this.random();
  }
}

/**
 * 字の大きさの倍率 (`big`・`small`)。ニコニコと同じ比 (普通 24・大 39・小 15)。
 * 取る縦の場所も同じ倍率で変わる
 */
export function sizeScale(size: "big" | "small" | undefined): number {
  return size === "big" ? 39 / 24 : size === "small" ? 15 / 24 : 1;
}
