/**
 * **デコードするのが間に合っているか**を確かめる (ライブを変換せずに送る経路。docs/stream.md#放送そのままmpeg-2を送る)。
 *
 * 変換せずに送ると MPEG-2 をデコードするのは端末の CPU で、1080i のデコードは机の上の PC で 1 コマ数 ms
 * (docs/stream.md#どこに時間が掛かっているか) だが、非力な端末や裏で重い仕事が走っている端末では間に合わないことがある。間に合わないまま続けると**映像だけが遅れていく**。音が
 * 時計なので、フレームは表示時刻を過ぎたものから捨てられ、紙芝居になる。
 *
 * そうなったらエンコードしたもの (サーバの ffmpeg) に戻す。次のどちらかに掛かった窓を数える。
 *
 * - **映像が時計から遅れている** (表示時刻を過ぎても次のフレームがデコードできていない) のが 0.25 秒を超えた
 * - **捨てたコマが多い** (窓の中で、出すはずだったコマの 15% 以上を間に合わずに捨てた)。遅れにぎりぎり掛からないまま
 *   紙芝居になっていた (同じ端末で 2 本見ていたとき。テロップの細い線がフィールドの順番の崩れで上下に震えて見えた)
 *
 * **1 コマをデコードする時間の 95 パーセンタイル**が 1 コマの長さの 8 割を超えても、それだけでは数えない
 * (8 割は、残りの 2 割をフレームを上げて描く分と音をデコードする分に残した目安)。時間は経過時間
 * (`decoder.c` の `last_ms`) で、worker が割り込まれた間も入る。1 秒 30 枚の 95 パーセンタイルは 2 番目に重いコマで、
 * I フレームにほぼ当たる。そのため worker がときどき止まる端末 (Galaxy S25) では、映像がほとんど崩れていないまま
 * この条件だけに掛かり続けて打ち切っていた (#2604)。本当に間に合わない端末は、遅れか捨てたコマに掛かる。
 * 時間は、打ち切ったときの条件 (`why`) と操作バーに出す
 *
 * どちらも**1 秒ごとに数えて、3 秒続いたら**打ち切る。1 回の重さ (タブを戻したとき・
 * GC・選局の直後) では戻さない。戻すと再エンコードで 1 秒近く映像が止まるので、
 * 一瞬の詰まりより高くつく。打ち切ったら、数えた窓ごとにどの条件に掛かったかを返す (`why`)。画面がコンソールに出力する。
 * 出力する前は、どの条件で打ち切ったかが外から読めず、端末ごとに切り分けられなかった
 *
 * ## エンコードしたものを canvas で描くとき (WebCodecs。`fmp4.ts`)
 *
 * デコードするのはブラウザの VideoDecoder で、たいてい GPU 経由。**1 コマの時間は物差しにならない**。
 * 渡してから出てくるまでに、詰まっていなくても数コマぶん溜めることがある (`timed: false`)。
 * 代わりに **VideoDecoder の詰まり** (`decodeQueueSize`) を見る: 窓の間ずっと
 * `QUEUE_STUCK` 枚以上残ったまま (一度も捌けきらない) なら間に合っていない。遅れは同じに数える。
 *
 * DOM も WASM も触らないので、ここだけ単体で確かめられる。
 */

/** 数える窓 (ms) */
export const WINDOW = 1_000;
/** これだけ続いたら打ち切る (窓の数) */
export const STRIKES = 3;
/** 1 コマの長さのうち、デコードするのに使ってよい割合 */
const SHARE = 0.8;
/** 映像がこれだけ時計から遅れたら「間に合っていない」(秒) */
const LATE = 0.25;
/** 窓の中にこれより少なければ数えない (止めている間・選局の直後) */
const LEAST = 5;
/** 窓の中で、出すはずだったコマのうちこれだけ捨てたら「間に合っていない」 */
const DROP_SHARE = 0.15;
/** 窓の中でこれより少なく捨てたなら数えない (1 秒に数枚は、選局の直後などでも捨てる) */
const DROP_LEAST = 5;
/** VideoDecoder に渡したまま、窓の間ずっとこれだけ残っていたら詰まっている (枚) */
export const QUEUE_STUCK = 3;

export class DecodeBudget {
  private samples: number[] = [];
  private from = Number.NaN;
  private worstLate = 0;
  private leastQueued = Number.POSITIVE_INFINITY;
  private strikes = 0;
  /** これより前 (ms) は数えない (`reset` の `until`) */
  private quietUntil = Number.NEGATIVE_INFINITY;
  /** 窓の始めでの、捨てたコマの数 (通しの数。窓ごとの差を見る) */
  private droppedFrom = Number.NaN;
  /** 直近の窓の 95 パーセンタイル (ms)。画面に出す */
  p95 = 0;
  /** 続けて数えた窓ごとの、掛かった条件 (`why`)。掛からない窓が来たら空にする */
  private struck: string[] = [];

  /**
   * @param timed 打ち切ったときの条件 (`why`) に 1 コマの時間を添えるか。WebCodecs の経路は添えない (上の説明)。時間は画面に出すので数える
   */
  constructor(private readonly timed = true) {}

  /** 1 コマデコードした時間 (ms) */
  record(ms: number): void {
    this.samples.push(ms);
  }

  /**
   * 刻むたびに呼ぶ。**打ち切るべきなら true。**
   *
   * @param now いまの時刻 (ms)
   * @param frameMs 1 コマの長さ (ms)。29.97 コマなら 33.4
   * @param late 映像が時計からどれだけ遅れているか (秒)。遅れていなければ 0
   * @param queued デコーダに渡したまま出てきていない枚数 (WebCodecs の `decodeQueueSize`)
   * @param dropped 間に合わずに捨てたコマの数 (通し)。**割る数は窓の長さぶんのコマ数** (出した数は飛び越し走査ではフィールドごとに数えるので使わない)
   * @param stretch 1 枚のデコードに使ってよい時間 (`why` に添える目安) を何倍にするか。B フレームを飛ばしている間は 2 (デコードする枚数が減るぶん、1 枚に掛けてよい)
   */
  tick(
    now: number,
    frameMs: number,
    late: number,
    queued = 0,
    dropped = 0,
    stretch = 1,
  ): boolean {
    // 追いついている最中 (`reset` の `until`)。窓はそのあとから始める
    if (now < this.quietUntil) {
      this.samples = [];
      return false;
    }
    if (Number.isNaN(this.from)) this.from = now;
    if (Number.isNaN(this.droppedFrom)) this.droppedFrom = dropped;
    if (late > this.worstLate) this.worstLate = late;
    if (queued < this.leastQueued) this.leastQueued = queued;
    if (now - this.from < WINDOW) return false;
    const samples = this.samples;
    const worst = this.worstLate;
    const least = this.leastQueued;
    this.samples = [];
    this.worstLate = 0;
    this.leastQueued = Number.POSITIVE_INFINITY;
    this.from = now;
    const lost = dropped - this.droppedFrom;
    this.droppedFrom = dropped;
    /*
     * 少なければ数えない。ただしデコーダが詰まったまま 1 枚も出さない (WebCodecs) と、出たコマで数える数は 0 のままなので、
     * 渡したものが窓の間ずっと残っていれば数える
     */
    const stuck = least >= QUEUE_STUCK;
    if (samples.length < LEAST && !stuck) return false;
    samples.sort((a, b) => a - b);
    const top = Math.min(samples.length - 1, Math.floor(samples.length * 0.95));
    if (top >= 0) this.p95 = samples[top]!;
    const choppy =
      lost >= DROP_LEAST && lost >= (WINDOW / frameMs) * DROP_SHARE;
    const limit = frameMs * SHARE * stretch;
    const hits: string[] = [];
    if (worst > LATE)
      hits.push(`映像の遅れ ${worst.toFixed(2)} 秒 (目安 ${LATE} 秒)`);
    if (stuck) hits.push(`デコーダに残ったまま ${least} 枚`);
    if (choppy)
      hits.push(
        `捨てたコマ ${lost} 枚 (目安 ${Math.ceil((WINDOW / frameMs) * DROP_SHARE)} 枚)`,
      );
    // デコードする時間だけでは数えない (上の説明)。数えた窓には、どの条件かを読み分けられるように添える
    if (hits.length === 0) {
      this.strikes = 0;
      this.struck = [];
      return false;
    }
    if (this.timed && this.p95 > limit)
      hits.unshift(
        `デコード ${this.p95.toFixed(1)} ms (目安 ${limit.toFixed(1)} ms)`,
      );
    this.strikes += 1;
    this.struck.push(hits.join("、"));
    return this.strikes >= STRIKES;
  }

  /**
   * 打ち切るまでに続けて数えた窓ごとの、掛かった条件。`tick` が true を返したあとに読む。窓は「 / 」で区切る
   * (「デコード 28.4 ms (目安 26.7 ms) / デコード 27.9 ms (目安 26.7 ms)、映像の遅れ 0.31 秒 (目安 0.25 秒) / …」)
   */
  why(): string {
    return this.struck.join(" / ");
  }

  /**
   * 選局し直したとき・裏から戻ったとき・止めていたのを再開したとき。**前のぶんは持ち越さない。**
   *
   * @param until この時刻 (ms) までは数えない。戻った・再開した直後は、映像が時計から大きく遅れたまま
   *   次の I まで飛んでデコードし直す (止めていた間に時計は放送の今へ進んでいる)。それを「間に合っていない」と
   *   数えると、続けて止める・再開するだけで打ち切っていた
   */
  reset(until = Number.NEGATIVE_INFINITY): void {
    this.strikes = 0;
    this.struck = [];
    this.quietUntil = Number.NEGATIVE_INFINITY;
    this.pause(until);
  }

  /**
   * **届いていない間は数えない。** 回線が詰まってデコードするデータが無いとき (変換せずに送る経路の `starved`)。
   * 映像が時計から遅れても、届いたあとに番を過ぎたコマを捨てても、デコードが間に合っていないのではない。
   * `until` (ms) までは数えず、窓はそのあとから始める。`reset` と違って、それまでに数えた打ち切りの回数は残す
   * (デコードが本当に遅い端末は、届いている間に続けて数える)
   */
  pause(until: number): void {
    this.quietUntil = Math.max(this.quietUntil, until);
    this.samples = [];
    this.from = Number.NaN;
    this.worstLate = 0;
    this.leastQueued = Number.POSITIVE_INFINITY;
    this.droppedFrom = Number.NaN;
  }
}
