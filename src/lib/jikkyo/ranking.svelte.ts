import { resolve } from "$app/paths";

import { parseRanking, rankOrder } from "./ranking";

/** 取りに行く間隔。サーバが NX-Jikkyo の勢いを持つ長さと同じ (細かく呼んでも同じものが返る) */
const EVERY = 30_000;

/**
 * **「実況」タブの勢い** (ライブの局の一覧。docs/screens.md のライブ)。
 *
 * - 取りに行くのは、タブを開いていて、ページが見えている間だけ。30 秒ごとに `GET /api/jikkyo/ranking`。
 *   隠れたら止め、見えるようになったらすぐ 1 回取る
 * - **並びは開いて最初に返ってきた時点で止め、数字だけ書き換える。** 最初の返事までは番号順で、数字は出さない。
 *   最初に読めなかったときは番号順のまま止める (開き直すまで変えない)
 * - 読めないとき (503・繋がらない・形がずれている) は数字を消し、「いまは勢いを読めません」を出す (通知は出さない)
 */
export class JikkyoRanking {
  /** 局ごとの勢い。読めていなければ null (数字を出さない) */
  forces = $state<ReadonlyMap<number, number> | null>(null);
  /** 最後に読めなかったか */
  failed = $state(false);
  /** 止めた並び (局の ID)。最初の返事までは null (番号順) */
  order = $state<number[] | null>(null);

  private ids: number[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private run = 0;
  /** 取りに行った回。通信中に見え直して次の回が始まったら、前の回の返事は捨てる (取りに行くのを 1 本に保つ) */
  private ticks = 0;

  /**
   * タブを開いた。`ids` は実況に対応している局を番号順に。
   * @returns 閉じる関数 (タブを離れた・設定をオフにした)
   */
  open(ids: number[]): () => void {
    this.ids = ids;
    this.forces = null;
    this.failed = false;
    this.order = null;
    const run = ++this.run;
    const onVisible = () => {
      if (document.visibilityState === "visible") void this.tick(run);
      else this.pause();
    };
    document.addEventListener("visibilitychange", onVisible);
    if (document.visibilityState === "visible") void this.tick(run);
    return () => {
      this.run++;
      this.pause();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }

  private pause(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private async tick(run: number): Promise<void> {
    this.pause();
    const tick = ++this.ticks;
    let forces: Map<number, number> | null = null;
    try {
      const res = await fetch(resolve("api/jikkyo/ranking"));
      if (res.ok) forces = parseRanking(await res.json());
    } catch {
      // 繋がらない。読めないのと同じ
    }
    if (run !== this.run || tick !== this.ticks) return;
    this.forces = forces;
    this.failed = forces === null;
    // 並びは最初の返事で 1 回だけ決める (読めなければ番号順のまま)
    this.order ??= rankOrder(this.ids, forces);
    this.pause();
    if (document.visibilityState === "visible")
      this.timer = setTimeout(() => void this.tick(run), EVERY);
  }
}
