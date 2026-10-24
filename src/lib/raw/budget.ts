/**
 * **デコードするのが間に合っているか**を見張る (ライブを変換せずに送る経路。docs/stream.md#放送そのままmpeg-2を送る)。
 *
 * 変換せずに送ると MPEG-2 をデコードするのは端末の CPU で、1080i は1コマ 10ms 前後 (実測: 手元の
 * Chromium で 90〜97 コマ/秒) だが、非力な端末や裏で重い仕事が走っている端末では
 * 間に合わないことがある。間に合わないまま続けると**映像だけが遅れていく** — 音が
 * 時計なので、フレームは表示時刻を過ぎたものから捨てられ、紙芝居になる。
 *
 * そうなったらエンコードしたもの (サーバの ffmpeg) に戻す。見るのは3つ:
 *
 * - **1コマをデコードする時間の 95 パーセンタイル**が、1コマの長さの 8 割を超えた
 *   (残りの 2 割はフレームを上げて描く分と、音をデコードする分)
 * - **映像が時計から遅れている** (表示時刻を過ぎても次のフレームがデコードできていない) のが 0.25 秒を超えた
 * - **捨てたコマが多い** (窓の中で、出すはずだったコマの 15% 以上を間に合わずに捨てた)。上の 2 つにぎりぎり掛からないまま
 *   紙芝居になっていた (同じ端末で 2 本見ていたとき。テロップの細い線がフィールドの順番の崩れで上下に震えて見えた)
 *
 * どれも**1秒ごとに数えて、3秒続いたら**諦める。1回の重さ (タブを戻したとき・
 * GC・選局の直後) では戻さない — 戻すと再エンコードで 1秒近く映像が止まるので、
 * 一瞬の詰まりより高くつく。
 *
 * ## エンコードしたものを canvas で描くとき (WebCodecs。`fmp4.ts`)
 *
 * デコードするのはブラウザの VideoDecoder で、たいてい GPU 経由。**1コマの時間は物差しにならない** —
 * 渡してから出てくるまでに、詰まっていなくても数コマぶん溜めることがある (`timed: false`)。
 * 代わりに **VideoDecoder の詰まり** (`decodeQueueSize`) を見る: 窓の間ずっと
 * `QUEUE_STUCK` 枚以上残ったまま (一度も捌けきらない) なら間に合っていない。遅れは同じに数える。
 *
 * DOM も WASM も触らないので、ここだけ単体で確かめられる。
 */

/** 数える窓 (ms) */
export const WINDOW = 1_000;
/** これだけ続いたら諦める (窓の数) */
export const STRIKES = 3;
/** 1コマの長さのうち、デコードするのに使ってよい割合 */
const SHARE = 0.8;
/** 映像がこれだけ時計から遅れたら「間に合っていない」(秒) */
const LATE = 0.25;
/** 窓の中にこれより少なければ数えない (止めている間・選局の直後) */
const LEAST = 5;
/** 窓の中で、出すはずだったコマのうちこれだけ捨てたら「間に合っていない」 */
const DROP_SHARE = 0.15;
/** 窓の中でこれより少なく捨てたなら数えない (1秒に数枚は、選局の直後などでも捨てる) */
const DROP_LEAST = 5;
/** VideoDecoder に渡したまま、窓の間ずっとこれだけ残っていたら詰まっている (枚) */
export const QUEUE_STUCK = 3;

export class DecodeBudget {
  private samples: number[] = [];
  private from = Number.NaN;
  private worstLate = 0;
  private leastQueued = Number.POSITIVE_INFINITY;
  private strikes = 0;
  /** 窓の頭での、捨てたコマと出したコマの数 (通しの数。窓ごとの差を見る) */
  private droppedFrom = Number.NaN;
  /** 直近の窓の 95 パーセンタイル (ms)。画面に出す */
  p95 = 0;

  /**
   * @param timed 1コマの時間で判じるか。WebCodecs の経路は判じない (上の説明)。時間は画面に出すので数える
   */
  constructor(private readonly timed = true) {}

  /** 1コマデコードした時間 (ms) */
  record(ms: number): void {
    this.samples.push(ms);
  }

  /**
   * 刻むたびに呼ぶ。**諦めるべきなら true。**
   *
   * @param now いまの時刻 (ms)
   * @param frameMs 1コマの長さ (ms)。29.97 コマなら 33.4
   * @param late 映像が時計からどれだけ遅れているか (秒)。遅れていなければ 0
   * @param queued デコーダに渡したまま出てきていない枚数 (WebCodecs の `decodeQueueSize`)
   * @param dropped 間に合わずに捨てたコマの数 (通し)。**割る数は窓の長さぶんのコマ数** (出した数は飛び越し走査ではフィールドごとに数えるので使わない)
   * @param stretch 1 枚のデコードに使ってよい時間を何倍にするか。B フレームを飛ばしている間は 2 (デコードする枚数が減るぶん、1 枚に掛けてよい)
   */
  tick(
    now: number,
    frameMs: number,
    late: number,
    queued = 0,
    dropped = 0,
    stretch = 1,
  ): boolean {
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
    if (samples.length < LEAST) return false;
    samples.sort((a, b) => a - b);
    this.p95 =
      samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!;
    const choppy =
      lost >= DROP_LEAST && lost >= (WINDOW / frameMs) * DROP_SHARE;
    const bad =
      (this.timed && this.p95 > frameMs * SHARE * stretch) ||
      worst > LATE ||
      least >= QUEUE_STUCK ||
      choppy;
    this.strikes = bad ? this.strikes + 1 : 0;
    return this.strikes >= STRIKES;
  }

  /** 選局し直したとき。**前の局のぶんは持ち越さない** */
  reset(): void {
    this.samples = [];
    this.from = Number.NaN;
    this.worstLate = 0;
    this.leastQueued = Number.POSITIVE_INFINITY;
    this.strikes = 0;
    this.droppedFrom = Number.NaN;
  }
}
