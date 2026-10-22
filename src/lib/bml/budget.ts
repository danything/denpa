/**
 * エンジンがページ (メインスレッド) を握る長さの決まり。**エンジンの仕事は全部この下で動かす。**
 *
 * - **1 つの仕事で握るのは `slice` ms まで。** 「仕事」はブラウザのタスク 1 つと、それに続く
 *   マイクロタスク全部。マイクロタスクの間はページは何もできない (描けない・キーも来ない) ので、
 *   約束の続き (`then`)・`queueMicrotask` で入り直しても**区切りは始め直さない**。使い切ったら
 *   続きは `setTimeout` で次のタスクへ回す
 * - **暴れている文書を見分ける。** 区切りで手を放しても、休みなく回り続ける文書 (描き直すと
 *   また描き直しを呼ぶ、など) はページを重くし続ける。`window` ms のうちエンジンが動いていた
 *   時間が `ratio` を超えたら、呼び手 (エンジン) が文書を止める
 *
 * 2026-10-12 本番: モジュールに無い画像を指す object を描くたびに取得し、すぐ「無い」と返って
 * 描き直す、がマイクロタスクで回り続けてタブごと固まった。区切りは `performance.now()` で
 * 見ていたのに、マイクロタスクで入り直すたびに区切りを始め直していたので効かなかった
 */

export interface BudgetLimits {
  /** 1 つの仕事で握ってよい長さ (ms) */
  slice: number;
  /** 暴れているかを見る区間 (ms) */
  window: number;
  /** 区間のうち、動いていてよい割合 */
  ratio: number;
}

export const DEFAULT_BUDGET: BudgetLimits = {
  slice: 5,
  window: 10_000,
  ratio: 0.4,
};

export class Budget {
  readonly limits: BudgetLimits;
  /** 今の仕事の始まり。次のタスクで null に戻す */
  private turn: number | null = null;
  private windowStart = performance.now();
  private windowBusy = 0;

  constructor(limits: Partial<BudgetLimits> = {}) {
    this.limits = { ...DEFAULT_BUDGET, ...limits };
  }

  /** 今の仕事の締め切り (`performance.now()` の値) */
  deadline(): number {
    if (this.turn === null) {
      const start = performance.now();
      this.turn = start;
      // ここに来るのは今のタスクとマイクロタスクが全部終わってから
      setTimeout(() => {
        if (this.turn === start) this.turn = null;
      }, 0);
    }
    return this.turn + this.limits.slice;
  }

  /** 今の仕事の区切りを使い切ったか */
  spent(): boolean {
    return performance.now() >= this.deadline();
  }

  /**
   * 動いた時間を足す。区間が終わっていれば締めて、動きすぎていたら true (文書を止める)
   *
   * @param ms 動いた長さ
   */
  account(ms: number): boolean {
    this.windowBusy += ms;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < this.limits.window) return false;
    const busy = this.windowBusy / elapsed;
    this.windowStart = now;
    this.windowBusy = 0;
    return busy > this.limits.ratio;
  }
}
