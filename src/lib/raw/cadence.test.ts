import { describe, expect, test } from "bun:test";

import { fieldAt, SmoothClock, Vsync, VsyncClock } from "./cadence";

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

describe("Vsync", () => {
  test("間隔と位置を覚え、次の切り替わりを出す", () => {
    const vsync = new Vsync();
    expect(vsync.next(0)).toBeNull();
    for (let i = 0; i < 10; i++) vsync.feed(5 + i * (1000 / 60));
    expect(vsync.period).toBeCloseTo(1000 / 60, 6);
    const last = 5 + 9 * (1000 / 60);
    expect(vsync.next(last)).toBeCloseTo(last + 1000 / 60, 6);
    expect(vsync.next(last + 1)).toBeCloseTo(last + 1000 / 60, 6);
    expect(vsync.next(last + 20)).toBeCloseTo(last + 2000 / 60, 6);
  });

  test("落とした回 (2回ぶん空いた) は間隔を崩さない", () => {
    const vsync = new Vsync();
    for (const at of [0, 16.667, 33.333, 66.667, 83.333, 133.333])
      vsync.feed(at);
    expect(vsync.period).toBeCloseTo(16.667, 2);
  });

  test("古い時刻しか無ければ当てにしない (裏に回った)", () => {
    const vsync = new Vsync();
    vsync.feed(0);
    vsync.feed(16.667);
    expect(vsync.next(2000)).toBeNull();
  });
});

describe("SmoothClock", () => {
  test("小さなずれは少しずつ寄せ、大きく飛べば合わせ直す", () => {
    const clock = new SmoothClock();
    clock.set(90_000, 1000);
    expect(clock.at(1010)).toBe(90_900);
    // 2ms ぶん (180) 先を言ってきた。1割だけ寄せる
    clock.set(90_000 + 1800 + 180, 1020);
    expect(clock.at(1020)).toBeCloseTo(90_000 + 1800 + 18, 6);
    // 1秒飛んだ (シークした・貯め直した)
    clock.set(500_000, 1040);
    expect(clock.at(1040)).toBe(500_000);
    clock.set(null, 1060);
    expect(clock.at(1060)).toBeNull();
  });
});

describe("fieldAt", () => {
  const frame = 3003;
  test("トップファーストは上・下の順、ボトムファーストは下・上の順", () => {
    expect(
      fieldAt({ pts: 0, interlaced: true, topFirst: true }, 0, frame),
    ).toBe(0);
    expect(
      fieldAt({ pts: 0, interlaced: true, topFirst: true }, 1502, frame),
    ).toBe(1);
    expect(
      fieldAt({ pts: 0, interlaced: true, topFirst: false }, 0, frame),
    ).toBe(1);
    expect(
      fieldAt({ pts: 0, interlaced: true, topFirst: false }, 1502, frame),
    ).toBe(0);
    expect(
      fieldAt({ pts: 0, interlaced: false, topFirst: true }, 1502, frame),
    ).toBe(-1);
  });
});

/**
 * 59.94i (1秒に 59.94 フィールド) を 60Hz の画面で 20 秒出したときの、画面の切り替わりごとに
 * 出たフィールドの並び。刻みは 4ms ごとで、デコード (1コマに1回、8〜20ms) の回は延びる。時計の組は
 * 20ms ごとに ±3ms 揺れて届く。
 *
 * - `aligned` … 次の画面の切り替わりの時点の PTS (`VsyncClock`) で選び、描いた回はデコードせず、
 *   デコードは切り替わりの直後に始める (いまの作り)
 * - それ以外 … 刻んだ時刻のまま選び、デコードしてから描く (前の作り)
 */
function simulate(
  aligned: boolean,
  seed: number,
): { repeats: number; skips: number } {
  const rand = random(seed);
  const period = 1000 / 60;
  const field = 3003 / 2;
  const base = 1_000_000;
  const truth = (wall: number) => base + wall * 90;
  const idAt = (pts: number) => Math.floor((pts - base) / field);

  const vsync = new Vsync();
  const smooth = new SmoothClock();
  const lock = new VsyncClock();
  let raw: { pts: number; at: number } | null = null;
  const commits: { at: number; id: number }[] = [];
  let drawn = Number.NaN;
  let decoded = 0;

  let nextVsync = 3.3;
  let nextClock = 0;
  let nextTick = 0;
  const seen: number[] = [];
  const end = 20_000;
  while (nextVsync < end) {
    const at = Math.min(nextVsync, nextClock, nextTick);
    if (at === nextVsync) {
      const shown = commits.findLast((c) => c.at < at);
      if (shown !== undefined) seen.push(shown.id);
      // rAF は少し遅れて届くが、時刻は切り替わりのもの
      vsync.feed(at);
      nextVsync += period;
    } else if (at === nextClock) {
      const stamp = at + (rand() - 0.5) * 6;
      raw = { pts: truth(at), at: stamp };
      smooth.set(truth(at), stamp);
      nextClock += 20;
    } else {
      // デコードは1コマ (2フィールド) に1回、8〜20ms。先に 8 コマまでデコードしておける
      const due = Math.floor((at * 90) / 3003);
      const wanted = decoded < due + 8;
      const urgent = decoded <= due + 1;
      const duration = 8 + rand() * 12;
      if (raw !== null) {
        if (aligned) {
          const target = vsync.next(at);
          const measured = smooth.at(target ?? at);
          const pts =
            target === null || measured === null
              ? measured
              : lock.pick(target, measured);
          const id = pts === null ? Number.NaN : idAt(pts);
          if (id !== drawn) {
            drawn = id;
            commits.push({ at, id });
            nextTick = at + 4;
            continue;
          }
          const decoding =
            wanted && (urgent || vsync.settled(at)) ? duration : 0;
          if (decoding > 0) decoded++;
          nextTick = at + Math.max(4, decoding);
          continue;
        }
        // デコードしてから描く。描いたものが画面へ渡るのは回の終わり
        const decoding = wanted ? duration : 0;
        if (decoding > 0) decoded++;
        const done = at + decoding;
        const id = idAt(raw.pts + (done - raw.at) * 90);
        if (id !== drawn) {
          drawn = id;
          commits.push({ at: done, id });
        }
        nextTick = Math.max(at + 4, done);
        continue;
      }
      nextTick = at + 4;
    }
  }
  let repeats = 0;
  let skips = 0;
  // 画面の切り替わりを覚えるまで (最初の数回) は数えない
  for (let i = 30; i < seen.length; i++) {
    const step = seen[i]! - seen[i - 1]!;
    if (step === 0) {
      repeats++;
    } else if (step > 1) {
      skips++;
    }
  }
  return { repeats, skips };
}

describe("59.94i を 60Hz の画面に出す", () => {
  test.each([1, 2, 3, 4, 5])(
    "フィールドを飛ばさず、同じフィールドを2回出すのは周波数の差のぶんだけ (乱数 %d)",
    (seed) => {
      const { repeats, skips } = simulate(true, seed);
      expect(skips).toBe(0);
      // 59.94 と 60 の差で 20 秒に 1.2 回
      expect(repeats).toBeLessThanOrEqual(2);
    },
  );

  test("刻んだ時刻で選ぶと、切り替わりの前後に揺れて飛びと重なりが出る (前の作り)", () => {
    const { repeats, skips } = simulate(false, 1);
    expect(repeats + skips).toBeGreaterThan(100);
  });
});

describe("Vsync (裏から戻ったとき)", () => {
  test("長く空いたあとは間隔を崩さず、位置だけ覚え直す", () => {
    const vsync = new Vsync();
    for (let i = 0; i < 10; i++) vsync.feed(i * (1000 / 60));
    vsync.feed(60_000.4);
    expect(vsync.period).toBeCloseTo(1000 / 60, 6);
    expect(vsync.next(60_001)).toBeCloseTo(60_000.4 + 1000 / 60, 6);
  });
});

describe("Vsync (覚えた間隔がずれたとき)", () => {
  /**
   * `period` ms ごとの画面の切り替わりを `frames` 回ぶん進め、rAF の時刻を流す。時刻は ±0.3ms 揺れ、
   * `drop` の割合で 1〜2 回ぶん来ない。最後の切り替わりの時刻を返す
   */
  function play(
    vsync: Vsync,
    from: number,
    period: number,
    frames: number,
    rand: () => number,
    drop = 0,
  ): number {
    let at = from;
    for (let i = 0; i < frames; i++) {
      at += period;
      if (rand() < drop) at += period * (rand() < 0.5 ? 1 : 2);
      vsync.feed(at + (rand() - 0.5) * 0.6);
    }
    return at;
  }

  const near = (vsync: Vsync, period: number) =>
    expect(Math.abs(vsync.period! - period)).toBeLessThan(0.2);

  test("混んで短い間が続き、間隔が本当の半分ほどに縮んでも戻る", () => {
    const rand = random(1);
    const vsync = new Vsync();
    let at = play(vsync, 0, 1000 / 60, 20, rand);
    // 混んで 8〜11ms の間が続いた
    for (let i = 0; i < 15; i++) {
      at += 8 + rand() * 3;
      vsync.feed(at);
    }
    expect(vsync.period!).toBeLessThan((1000 / 60) * (2 / 3));
    play(vsync, at, 1000 / 60, 120, rand);
    near(vsync, 1000 / 60);
  });

  test("60Hz で、ときどき落とす (2〜3回ぶん空く) 回があっても 16.67ms を覚える", () => {
    const rand = random(2);
    const vsync = new Vsync();
    play(vsync, 0, 1000 / 60, 600, rand, 0.15);
    near(vsync, 1000 / 60);
  });

  test("120Hz と 50Hz の画面も、落とす回があっても間隔を覚える", () => {
    for (const period of [1000 / 120, 1000 / 50]) {
      const rand = random(3);
      const vsync = new Vsync();
      play(vsync, 0, period, 600, rand, 0.15);
      near(vsync, period);
    }
  });

  test("画面の速さが変わったら (60Hz→120Hz、120Hz→60Hz) 60 回のうちに追いつく", () => {
    const rand = random(4);
    const vsync = new Vsync();
    let at = play(vsync, 0, 1000 / 60, 120, rand);
    at = play(vsync, at, 1000 / 120, 60, rand);
    near(vsync, 1000 / 120);
    play(vsync, at, 1000 / 60, 60, rand);
    near(vsync, 1000 / 60);
  });

  test("rAF の 4 割が来ない間が続いても、来るようになれば 16.67ms に戻る", () => {
    const rand = random(5);
    const vsync = new Vsync();
    let at = play(vsync, 0, 1000 / 60, 60, rand);
    at = play(vsync, at, 1000 / 60, 300, rand, 0.4);
    play(vsync, at, 1000 / 60, 100, rand);
    near(vsync, 1000 / 60);
  });
});
