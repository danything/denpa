/**
 * **受け取りの速さを測る** (観る画面の `remux-player.ts`・`canvas-player.ts`。段の上げ下げに渡す。`#lib/adapt.ts` の `AdaptSample.throughput`)。
 *
 * 数えるのは**読んでいる間だけ**。先が埋まって読むのを止めている間 (`AHEAD`) を混ぜると、回線が太くても遅く見える。
 * 窓は読んでいた時間で 5 秒ぶん。読むのを止めている間は窓が進まないので、最後に測った値をそのまま返す。
 *
 * 読むのを止めていた間にも、ブラウザは回線から受け取って手元に溜めている。読み始めてすぐの塊は待たずに返るので、
 * 回線の速さとして数えない (`draining`)。待って返った塊が来てから数え始める (待たずに返り続けても、`METER_DRAIN_MOST` を過ぎたら数え始める)
 */

/** 窓の長さ (ms。読んでいた時間) */
const METER_WINDOW = 5_000;
/** これだけ読んでから値を返す (ms)。1 つ 2 つの塊では揺れが大きい */
const METER_LEAST = 1_000;
/**
 * 読み出しがこれより早く返ったら、手元に溜まっていたものと見る (ms)。回線から届くのを待った読み出しは、
 * 塊 1 つぶん (数十 KB) を受け取る時間がかかる
 */
export const METER_QUEUED = 4;
/**
 * 止めたあと、溜まっていたものを読む (数えない) のはこれまで (ms。最初に読んでから)。これを過ぎたら、待たずに返った塊も数える。
 * 速い回線では、足すのを待っている間 (`appendBuffer`) に次の塊が届いて手元に溜まるので、読み出しは毎回待たずに返る。
 * 待って返った塊だけを合図にしていた頃は、そのまま測り直せず、絞りを外しても段が上がらなかった (手元で 15 Mbit/s 届いて
 * いるのに、最後に測った 2 Mbit/s のまま)。手元に溜まるのはブラウザの受け取りの入れ物のぶん (数 MB まで) で、
 * 速い回線なら 1 秒もかからずに読み切る
 */
export const METER_DRAIN_MOST = 1_000;

export class Meter {
  /** 塊ごとのバイト数と、それを受け取るのにかかった時間 (ms)。古い順 */
  private samples: { bytes: number; ms: number }[] = [];
  private bytes = 0;
  private ms = 0;
  /** 前の塊が届いた時刻。数えていなければ null */
  private last: number | null = null;
  /** 手元に溜まっていたものを読んでいる最中か */
  private draining = true;
  /** 溜まっていたものを読み始めた時刻 (`METER_DRAIN_MOST`)。まだ読んでいなければ null */
  private drainFrom: number | null = null;
  /** 最後に測った時刻 (ms)。まだなら null */
  measuredAt: number | null = null;

  /**
   * 読むのを止めた (先が埋まった・リクエストし直した)。次に読み始めたときは、手元に溜まっていたものから返る。
   * 測った値は捨てない
   */
  pause(): void {
    this.last = null;
    this.draining = true;
    this.drainFrom = null;
  }

  /**
   * 塊が 1 つ届いた。`asked` は読み出しを始めた時刻、`now` は返った時刻 (ms)
   */
  add(bytes: number, asked: number, now: number): void {
    if (this.draining) {
      this.drainFrom ??= asked;
      if (now - asked < METER_QUEUED && now - this.drainFrom < METER_DRAIN_MOST)
        return;
      // 待って返った (か、`METER_DRAIN_MOST` を過ぎた)。ここから先は回線から届いたもの。この塊は待ち始めが分からないので、時刻だけ控える
      this.draining = false;
      this.last = now;
      return;
    }
    if (this.last === null) {
      this.last = now;
      return;
    }
    const ms = now - this.last;
    this.last = now;
    this.samples.push({ bytes, ms });
    this.bytes += bytes;
    this.ms += ms;
    while (
      this.samples.length > 1 &&
      this.ms - this.samples[0]!.ms >= METER_WINDOW
    ) {
      const first = this.samples.shift()!;
      this.bytes -= first.bytes;
      this.ms -= first.ms;
    }
    if (this.ms >= METER_LEAST) this.measuredAt = now;
  }

  /** 測った速さ (bit/s)。まだ測れていなければ null */
  bps(): number | null {
    if (this.measuredAt === null || this.ms <= 0) return null;
    return (this.bytes * 8 * 1000) / this.ms;
  }
}
