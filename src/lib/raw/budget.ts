/**
 * **解くのが間に合っているか**を見張る (ライブを生で送る道。docs/stream.md §5.5)。
 *
 * 生で送ると MPEG-2 を解くのは端末の CPU で、1080i は1コマ 10ms 前後 (実測: 手元の
 * Chromium で 90〜97 コマ/秒) だが、非力な端末や裏で重い仕事が走っている端末では
 * 間に合わないことがある。間に合わないまま続けると**絵だけが遅れていく** — 音が
 * 時計なので、絵は番を過ぎたものから捨てられ、紙芝居になる。
 *
 * そうなったら焼いたもの (サーバの ffmpeg) に戻す。見るのは2つ:
 *
 * - **1コマを解く時間の 95 パーセンタイル**が、1コマの長さの 8 割を超えた
 *   (残りの 2 割は絵を上げて描く分と、音を解く分)
 * - **絵が時計から遅れている** (番を過ぎても次の絵が解けていない) のが 0.25 秒を超えた
 *
 * どちらも**1秒ごとに数えて、5秒続いたら**諦める。1回の重さ (タブを戻したとき・
 * GC・選局の直後) では戻さない — 戻すと焼き直しで 1秒近く絵が止まるので、
 * 一瞬の詰まりより高くつく。
 *
 * DOM も WASM も触らないので、ここだけ単体で確かめられる。
 */

/** 数える窓 (ms) */
export const WINDOW = 1_000;
/** これだけ続いたら諦める (窓の数) */
export const STRIKES = 5;
/** 1コマの長さのうち、解くのに使ってよい割合 */
export const SHARE = 0.8;
/** 絵がこれだけ時計から遅れたら「間に合っていない」(秒) */
export const LATE = 0.25;
/** 窓の中にこれより少なければ数えない (止めている間・選局の直後) */
const LEAST = 5;

export class DecodeBudget {
    private samples: number[] = [];
    private from = Number.NaN;
    private worstLate = 0;
    private strikes = 0;
    /** 直近の窓の 95 パーセンタイル (ms)。画面に出す */
    p95 = 0;

    /** 1コマ解いた時間 (ms) */
    record(ms: number): void {
        this.samples.push(ms);
    }

    /**
     * 刻むたびに呼ぶ。**諦めるべきなら true。**
     *
     * @param now いまの時刻 (ms)
     * @param frameMs 1コマの長さ (ms)。29.97 コマなら 33.4
     * @param late 絵が時計からどれだけ遅れているか (秒)。遅れていなければ 0
     */
    tick(now: number, frameMs: number, late: number): boolean {
        if (Number.isNaN(this.from)) this.from = now;
        if (late > this.worstLate) this.worstLate = late;
        if (now - this.from < WINDOW) return false;
        const samples = this.samples;
        const worst = this.worstLate;
        this.samples = [];
        this.worstLate = 0;
        this.from = now;
        if (samples.length < LEAST) return false;
        samples.sort((a, b) => a - b);
        this.p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!;
        const bad = this.p95 > frameMs * SHARE || worst > LATE;
        this.strikes = bad ? this.strikes + 1 : 0;
        return this.strikes >= STRIKES;
    }

    /** 選局し直したとき。**前の局のぶんは持ち越さない** */
    reset(): void {
        this.samples = [];
        this.from = Number.NaN;
        this.worstLate = 0;
        this.strikes = 0;
    }
}
