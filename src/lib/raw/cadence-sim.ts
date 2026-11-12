/**
 * **worker の刻み (`worker.ts` の `tick`) を写した模擬。** デコードをいつ始めるか (`Gate`) を差し替えて、
 * 画面の切り替わりごとにどのフィールドが出たかを数える (`cadence-sim.test.ts`)。
 *
 * 写しているもの
 *
 * - 画面の切り替わり: `rate` 回/秒。rAF の時刻は ±0.3ms 揺れ、2% は来ない。届くのは 1〜3ms 後
 * - worker の刻み: 始めた時刻から 4〜5ms 後 (前の回が延びればその後)。届いた rAF の時刻はその前に `Vsync` へ渡す
 * - 刻みの中身: 先に出す (`present`)。描かなかった回だけ、`Gate` が許せば 1 枚デコードする (遅れていれば 3 枚まで)。
 *   デコードできたものが無ければ `Gate` を見ない。デコードしたあとにもう一度出す
 * - デコード: 29.97 コマ、GOP 15 (I・B・B・P…)。1 枚 `decodeMs` × (1 ± `spread`。既定は 0.25)、I は ×1.3、B は ×0.9。
 *   先にデコードしておけるのは 8 枚、番の 0.3 秒前まで。デコードはその間ほかの仕事を止める
 * - 描いたもの: その回の終わりに画面へ渡り、1ms 後より後の切り替わりから出る
 * - 時計: 本当の PTS をそのまま使う (時計の揺れは `cadence.test.ts` で見る)。出すフィールドは
 *   次の切り替わりの時点の PTS で選ぶ
 *
 * 写していないもの: B を飛ばす (`dec_skip`)・打ち切ってエンコードしたものに戻る。どちらも掛かるかどうかだけ数える
 */

import { CLOCK } from "@danything/arib/pes";

import { DecodeBudget } from "./budget";
import { COST_SAMPLES, mayDecode, type Shown, Vsync } from "./cadence";

/** デコードを始めてよいか。先にデコードしたものがあるときだけ聞く */
export type Gate = (state: GateState) => boolean;

export interface GateState {
  /** いまの時刻 (ms) */
  wall: number;
  vsync: Vsync;
  /** 次の切り替わりの時点の PTS */
  at: number;
  shown: Shown | null;
  /** 1 コマの長さ (90kHz) */
  frame: number;
  /** 直近にデコードした時間 (ms。`COST_SAMPLES` 枚まで)。新しいものが後ろ */
  recent: number[];
  /** デコードできて待っているコマの数 */
  decoded: number;
}

/**
 * 比べる区切り方。`change` がいまの作り (`mayDecode`)
 *
 * - `half` … 次の切り替わりまでが間隔の半分より長いときだけ (前の作り)
 * - `none` … 区切らない
 * - `fixed` … 次の切り替わりまでが 4ms より長いときだけ
 * - `change` … 描くものが次に変わる切り替わりまでに、見積もった時間でデコードを終えられるときだけ
 */
export const GATES = {
  half: ({ vsync, wall }) => {
    const next = vsync.next(wall);
    return next === null || next - wall > vsync.period! / 2;
  },
  none: () => true,
  fixed: ({ vsync, wall }) => {
    const next = vsync.next(wall);
    return next === null || next - wall > 4;
  },
  change: ({ vsync, wall, at, shown, frame, recent, decoded }) =>
    mayDecode(vsync, wall, at, shown, frame, recent, decoded),
} satisfies Record<string, Gate>;

export interface SimOptions {
  /** 画面の切り替わり (回/秒) */
  rate: number;
  /** 1 枚をデコードする時間の目安 (ms) */
  decodeMs: number;
  /** 1 枚の時間の揺れ (割合)。既定は 0.25 */
  spread?: number;
  seed: number;
  /** 数える長さ (ms)。最初の 2 秒は数えない */
  duration?: number;
}

export interface SimResult {
  /** 出たフィールドが、その切り替わりで出すはずのフィールドと違った切り替わり */
  off: number;
  /** 同じフィールドを出した回数が想定 (120Hz なら 2 回) と違ったフィールドと、1 回も出なかったフィールド */
  uneven: number;
  /** 描いたのが、狙った切り替わりより後に出た回 */
  late: number;
  /** 番を過ぎて捨てたコマ */
  dropped: number;
  /** B を飛ばしはじめる条件 (1 秒に 3 枚以上捨てた・0.1 秒以上遅れた) に掛かった秒 */
  thin: number;
  /** 打ち切りの窓に数えた回 (`budget.ts`) */
  strikes: number;
  /** 打ち切ったか (3 回続けて数えた) */
  failed: boolean;
}

/** 決まった並びの乱数 (mulberry32) */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FRAME = 3003;
const FIELD = FRAME / 2;
const DECODED_MOST = 8;
const AHEAD = 0.3 * CLOCK;
const WARMUP = 2_000;

export function simulate(gate: Gate, options: SimOptions): SimResult {
  const { rate, decodeMs, seed } = options;
  const spread = options.spread ?? 0.25;
  const duration = options.duration ?? 60_000;
  const end = WARMUP + duration;
  const rand = random(seed);
  const period = 1000 / rate;
  const phase = rand() * period;
  const base = 1_000_000 + Math.floor(rand() * FRAME);
  const truth = (wall: number) => base + wall * (CLOCK / 1000);
  /** 何番目の切り替わりか */
  const indexOf = (wall: number) => Math.round((wall - phase) / period);
  const vsyncAt = (k: number) => phase + k * period;
  /** フィールドの通し番号 */
  const fieldId = (pts: number) => Math.floor((pts - base) / FIELD);

  const vsync = new Vsync();
  const budget = new DecodeBudget();
  /** 届いた rAF の時刻 (届く時刻, 時刻) */
  const raf: { arrive: number; at: number }[] = [];
  for (let k = 0; vsyncAt(k) < end + 100; k++) {
    if (rand() < 0.02) continue;
    raf.push({
      arrive: vsyncAt(k) + 1 + rand() * 2,
      at: vsyncAt(k) + (rand() - 0.5) * 0.6,
    });
  }
  let rafIndex = 0;

  /** デコードできたコマ (表示順の通し番号) */
  const decoded: number[] = [];
  /** 次にデコードするコマ */
  let nextFrame = Math.floor((truth(0) - base) / FRAME);
  const ptsOf = (n: number) => base + n * FRAME;
  let shown: Shown | null = null;
  let shownFrame = -1;
  let drawn = { frame: -1, field: -1 };
  const recent: number[] = [];
  let dropped = 0;
  /** 画面へ渡したもの (渡した時刻, フィールドの通し番号, 狙った切り替わり) */
  const commits: { at: number; id: number; target: number }[] = [];
  let late = 0;
  let thin = 0;
  let strikes = 0;
  let failed = false;
  let thinFrom = WARMUP;
  let thinDropped = 0;
  let thinLate = 0;

  const cost = (n: number) => {
    const slot = ((n % 15) + 15) % 15;
    const kind = slot === 0 ? 1.3 : slot % 3 === 0 ? 1 : 0.9;
    return decodeMs * (1 - spread + rand() * 2 * spread) * kind;
  };

  let wall = 0;
  while (wall < end) {
    while (rafIndex < raf.length && raf[rafIndex]!.arrive <= wall) {
      vsync.feed(raf[rafIndex]!.at);
      rafIndex++;
    }
    const start = wall;
    const target = vsync.next(wall);
    // 時計の揺れは見ないので、狙った切り替わりの本当の時刻の PTS
    const at = truth(target === null ? wall : vsyncAt(indexOf(target)));
    const pending: { at: number; id: number; target: number }[] = [];

    const present = (): boolean => {
      while (decoded.length >= 2 && ptsOf(decoded[1]!) <= at) {
        decoded.shift();
        dropped++;
      }
      if (decoded.length >= 1 && ptsOf(decoded[0]!) <= at) {
        shownFrame = decoded.shift()!;
        shown = { pts: ptsOf(shownFrame), interlaced: true, topFirst: true };
        wall += 0.6;
      }
      if (shown === null) return false;
      const second = at >= shown.pts + FIELD ? 1 : 0;
      if (drawn.frame === shownFrame && drawn.field === second) return false;
      drawn = { frame: shownFrame, field: second };
      wall += 0.3;
      pending.push({
        at: 0,
        id: shownFrame * 2 + second,
        target: target === null ? Number.NaN : indexOf(target),
      });
      return true;
    };

    if (!present()) {
      const ready =
        decoded.length === 0 ||
        gate({
          wall,
          vsync,
          at,
          shown,
          frame: FRAME,
          recent,
          decoded: decoded.length,
        });
      for (let i = 0; ready && i < 3 && decoded.length < DECODED_MOST; i++) {
        const dts = ptsOf(nextFrame) - FRAME;
        if (dts > at + AHEAD || (i > 0 && dts > at)) break;
        const ms = cost(nextFrame);
        wall += ms;
        recent.push(ms);
        if (recent.length > COST_SAMPLES) recent.shift();
        if (start >= WARMUP) budget.record(ms);
        decoded.push(nextFrame);
        nextFrame++;
      }
      present();
    }
    wall += 0.1;
    for (const commit of pending) {
      commit.at = wall;
      commits.push(commit);
    }

    if (start >= WARMUP) {
      const behind =
        shown === null || decoded.length > 0
          ? 0
          : Math.max(0, (at - (shown as Shown).pts - FRAME) / CLOCK);
      if (behind > thinLate) thinLate = behind;
      if (start - thinFrom >= 1000) {
        if (dropped - thinDropped >= 3 || thinLate >= 0.1) thin++;
        thinFrom = start;
        thinDropped = dropped;
        thinLate = 0;
      }
      const before = budget.why();
      if (budget.tick(start, (FRAME / CLOCK) * 1000, behind, 0, dropped))
        failed = true;
      if (budget.why() !== before && budget.why() !== "") strikes++;
    }
    wall = Math.max(wall, start + 4 + rand());
  }

  // 切り替わりごとに出ていたフィールド
  let off = 0;
  const runs: number[] = [];
  let run = 0;
  let previous = Number.NaN;
  let skipped = 0;
  let c = 0;
  let current = Number.NaN;
  const first = indexOf(WARMUP) + 1;
  const last = indexOf(end) - 1;
  for (let k = 0; k <= last; k++) {
    const v = vsyncAt(k);
    // 1ms 前までに渡したものが出る
    while (c < commits.length && commits[c]!.at < v - 1) {
      const commit = commits[c]!;
      if (k >= first && commit.target < k) late++;
      current = commit.id;
      c++;
    }
    if (k < first) continue;
    if (current !== fieldId(truth(v))) off++;
    if (current === previous) run++;
    else {
      if (run > 0 && current - previous > 1) skipped += current - previous - 1;
      if (run > 0) runs.push(run);
      run = 1;
    }
    previous = current;
  }
  // 1 フィールドを何回出すか。60Hz と 120Hz はそれぞれ 1 回・2 回、90Hz は 1 回と 2 回、144Hz は 2 回と 3 回
  const ratio = rate / (CLOCK / FIELD);
  const allowed =
    Math.abs(ratio - Math.round(ratio)) < 0.05
      ? [Math.round(ratio)]
      : [Math.floor(ratio), Math.ceil(ratio)];
  const uneven =
    runs.slice(1).filter((n) => !allowed.includes(n)).length + skipped;
  return { off, uneven, late, dropped, thin, strikes, failed };
}
