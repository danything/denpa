/**
 * **季節の演出の、画面が持つところ** (決め方は `season.ts`。docs/screens.md「季節の演出」)。
 *
 * - 日付は**サーバの時計**で決める。開いたときに `GET /api/season` で一度だけサーバの時刻をもらい、端末の時計とのずれを覚える。
 *   もらえるまで (と、もらえなかったとき) は何も出さない
 * - 出すかどうか (世帯の設定 `seasonal`) は `+layout.svelte` が load の値で入れる。設定を切り替えると次の load で替わる
 */
import { resolve } from "$app/paths";

class Season {
  /** 世帯の設定がオンか */
  on = $state(false);
  /** サーバの時計 − 端末の時計 (ms)。サーバの時刻をもらえるまでは null */
  skew = $state<number | null>(null);
  /** 「denpa の 1 年」のチップを世帯で最後に閉じた年 */
  greeted = $state<number | null>(null);
  private loading = false;

  /** 出してよいか (オンで、サーバの時刻をもらえた) */
  get ready(): boolean {
    return this.on && this.skew !== null;
  }

  /** サーバの時計の今 (unix ms)。サーバの時刻をもらえる前は端末の時計 */
  now(): number {
    return Date.now() + (this.skew ?? 0);
  }

  /** サーバの時刻をもらう。1 回だけ */
  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const sent = Date.now();
      const response = await fetch(resolve("api/season"), {
        cache: "no-store",
      });
      if (!response.ok) return;
      const body = (await response.json()) as {
        now?: unknown;
        greeted?: unknown;
      };
      if (typeof body.now !== "number") return;
      // 行きと帰りの真ん中でサーバが時刻を読んだとみなす
      this.skew = body.now - (sent + Date.now()) / 2;
      this.greeted = typeof body.greeted === "number" ? body.greeted : null;
    } catch {
      // 読めなければ出さない (日付を端末の時計では決めない)
    }
  }
}

export const season = new Season();
