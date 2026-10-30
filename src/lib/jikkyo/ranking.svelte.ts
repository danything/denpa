import { resolve } from "$app/paths";

import { type HoldReason, ListHold, parseRanking, rankOrder } from "./ranking";

/** 取りに行く間隔。サーバが NX-Jikkyo の勢いを持つ長さと同じ (細かく呼んでも同じものが返る) */
const EVERY = 30_000;

/**
 * **「実況」タブの勢い** (ライブの局の一覧。docs/screens.md のライブ)。
 *
 * - 取りに行くのは、タブを開いていて、ページが見えている間だけ。30 秒ごとに `GET /api/jikkyo/ranking`。
 *   隠れたら止め、見えるようになったらすぐ 1 回取る
 * - **数字が届くたびに勢いの順に並べ直す。** 最初の返事までは番号順で、数字は出さない
 * - **一覧を使っている間 (`hold`) は並べ直しを待つ。** 数字だけ書き換え、離れてから並べ直す (`ListHold`)。
 *   押そうとした行が動いて別の局を選ばないように
 * - 読めないとき (503・繋がらない・形がずれている) は数字を消して番号順に戻し、「いまは勢いを読めません」を出す (通知は出さない)
 */
export class JikkyoRanking {
  /** 局ごとの勢い。読めていなければ null (数字を出さない) */
  forces = $state<ReadonlyMap<number, number> | null>(null);
  /** 最後に読めなかったか */
  failed = $state(false);
  /** 見せている並び (局の ID)。最初の返事までは null (番号順) */
  order = $state<number[] | null>(null);

  private ids: number[] = [];
  /** 一覧を使っている間に届いた並び。離れたら `order` に移す */
  private next: number[] | null = null;
  private readonly holder = new ListHold(() => this.apply());
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
    this.next = null;
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
      this.holder.clear();
      this.next = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }

  /** 一覧を使い始めた・やめた (指・ポインタが乗った・キーボードのフォーカスが入った) */
  hold(reason: HoldReason, on: boolean): void {
    this.holder.set(reason, on);
  }

  /** 一覧を巻いた。止まってしばらくは並べ直さない */
  scrolled(): void {
    if (this.next !== null) this.holder.poke();
  }

  private apply(): void {
    const next = this.next;
    this.next = null;
    if (next === null) return;
    // 同じ並びなら書き換えない (行を動かす合図にしない)
    const same =
      this.order !== null &&
      this.order.length === next.length &&
      this.order.every((id, index) => id === next[index]);
    if (!same) this.order = next;
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
    // 数字はすぐ替え、並びは一覧を使っていなければすぐ、使っていれば離れてから
    this.next = rankOrder(this.ids, forces);
    if (!this.holder.held) this.apply();
    this.pause();
    if (document.visibilityState === "visible")
      this.timer = setTimeout(() => void this.tick(run), EVERY);
  }
}
