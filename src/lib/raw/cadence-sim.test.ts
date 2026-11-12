import { describe, expect, test } from "bun:test";

import { type Gate, GATES, type SimResult, simulate } from "./cadence-sim";

const SEEDS = [1, 2, 3, 4, 5];

/** 乱数 5 通りの平均 (1 分あたり) */
function average(
  gate: Gate,
  rate: number,
  decodeMs: number,
  spread = 0.25,
): SimResult {
  const sum = {
    off: 0,
    uneven: 0,
    late: 0,
    dropped: 0,
    thin: 0,
    strikes: 0,
    failed: false,
  };
  for (const seed of SEEDS) {
    const result = simulate(gate, { rate, decodeMs, seed, spread });
    sum.off += result.off / SEEDS.length;
    sum.uneven += result.uneven / SEEDS.length;
    sum.late += result.late / SEEDS.length;
    sum.dropped += result.dropped / SEEDS.length;
    sum.thin += result.thin / SEEDS.length;
    sum.strikes += result.strikes / SEEDS.length;
    sum.failed ||= result.failed;
  }
  return sum;
}

/**
 * デコードを始める間合い (`mayDecode`) を、worker の刻みを写した模擬 (`cadence-sim.ts`) で前の作りと比べる。
 * 数は 1 分あたりの、出すはずのフィールドと違うものが出た画面の切り替わり (`off`)。実機では確かめていない
 */
describe("デコードを始める間合い (模擬)", () => {
  test.each([5, 8, 10, 13])(
    "60Hz で 1 枚 %dms なら、フィールドはずれず、コマも捨てない",
    (decodeMs) => {
      const result = average(GATES.change, 60, decodeMs);
      expect(result.off).toBe(0);
      expect(result.dropped).toBe(0);
      expect(result.failed).toBe(false);
    },
  );

  test.each([
    [120, 10],
    [120, 13],
    [144, 10],
    [90, 13],
  ])(
    "%dHz で 1 枚 %dms なら、前の作り (切り替わりの間隔の前半だけ) の 1/4 より少ない",
    (rate, decodeMs) => {
      const before = average(GATES.half, rate, decodeMs);
      const after = average(GATES.change, rate, decodeMs);
      expect(after.off).toBeLessThan(before.off / 4);
    },
  );

  test.each([
    [60, 0.25],
    [90, 0.25],
    [120, 0.25],
    [144, 0.25],
    [60, 0.45],
    [90, 0.45],
    [120, 0.45],
    [144, 0.45],
  ])(
    "%dHz で 1 枚 5〜16ms (揺れ ±%p) のどれも、前の作りより目立って増えない",
    (rate, spread) => {
      for (const decodeMs of [5, 8, 10, 13, 16]) {
        const before = average(GATES.half, rate, decodeMs, spread);
        const after = average(GATES.change, rate, decodeMs, spread);
        expect(after.off).toBeLessThanOrEqual(before.off * 1.1 + 5);
        expect(after.late).toBeLessThanOrEqual(before.late * 1.1 + 5);
        expect(after.dropped).toBeLessThanOrEqual(before.dropped);
        expect(after.failed).toBe(false);
      }
    },
  );
});
