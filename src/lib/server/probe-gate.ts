/**
 * **回線の速さを測る試しのデータ (`GET /api/playback/probe`) の回数の制限。** 同じ利用者 (ログインしていなければ同じ送り元) は、
 * 前に取ってから `PROBE_GAP` たつまで次を取れない。1 回は最大 4MB なので、繰り返し取られるとサーバの上りを使い切る。
 *
 * 画面が測るのは、足りない兆しが 30 秒無かったときだけ (`adapt.ts` の `UP_WAIT_LIVE`) なので、ふつうはこの間隔に届かない。
 * 同じ利用者が画面を 2 つ開いていると、片方は断られて次の機会まで待つ (断られたら、画面は `Retry-After` まで測らない)
 *
 * 数えるのはこのプロセスのメモリの中だけ。denpa は 1 つのプロセスで動かす前提なので、それで足りる
 */

/** 同じ利用者が次の試しのデータを取れるまでの間 (ms) */
export const PROBE_GAP = 10_000;
/** 覚えておく利用者の数の上限。超えたら古いものから忘れる (送り元を変えて増やされても、覚える量は増えない) */
const KEEP_MOST = 1_000;

export class ProbeGate {
  private readonly last = new Map<string, number>();

  /** `key` が `now` (ms) に取ってよいか。よければ 0 を返して覚え、だめなら取れるまでの残り (ms) を返す */
  allow(key: string, now: number): number {
    const at = this.last.get(key);
    if (at !== undefined && now - at < PROBE_GAP) return PROBE_GAP - (now - at);
    this.last.delete(key);
    this.last.set(key, now);
    while (this.last.size > KEEP_MOST) {
      const oldest = this.last.keys().next().value;
      if (oldest === undefined) break;
      this.last.delete(oldest);
    }
    return 0;
  }
}
