import { describe, expect, test } from "bun:test";

import { laneCount, Lanes, lineHeight, SPAN_MS, textWidth } from "./lanes";

/*
 * コメントを流す行の割り当て
 */

describe("行の大きさ", () => {
  test("行の高さは枠の 1/14 (下限 14px)。上下に余白を残しておよそ 13 行", () => {
    expect(lineHeight(1080)).toBeCloseTo(1080 / 14);
    expect(lineHeight(100)).toBe(14);
    expect(laneCount(1080)).toBe(13);
  });

  test("半角は字の大きさの 0.55 倍、全角は 1 倍とみなす", () => {
    expect(textWidth("ab", 20)).toBeCloseTo(22);
    expect(textWidth("あい", 20)).toBe(40);
  });
});

describe("Lanes", () => {
  test("上の行から使い、前のコメントの尻尾が入りきるまで同じ行に入れない", () => {
    const lanes = new Lanes(2);
    // 幅 1000px の枠で、幅 200px のコメント。速さは 1000px / 4 秒
    const first = lanes.flow(0, 200, 1000, 20);
    expect(first).toEqual({
      lane: 0,
      duration: ((1000 + 200) / 1000) * SPAN_MS,
    });
    expect(lanes.flow(100, 200, 1000, 20)?.lane).toBe(1);
    // 尻尾 (200px + 間 20px) が入りきるのは 880ms 後
    expect(lanes.flow(800, 200, 1000, 20)).toBeNull();
    expect(lanes.flow(880, 200, 1000, 20)?.lane).toBe(0);
  });

  test("空いた行が無ければ捨てる (null)。飛んだら全部空ける", () => {
    const lanes = new Lanes(1);
    lanes.flow(0, 100, 1000, 20);
    expect(lanes.flow(1, 100, 1000, 20)).toBeNull();
    lanes.clear();
    expect(lanes.flow(1, 100, 1000, 20)?.lane).toBe(0);
  });

  test("動きを減らす設定では、3 秒置いて空ける", () => {
    const lanes = new Lanes(1);
    expect(lanes.still(0)).toEqual({ lane: 0, duration: 3000 });
    expect(lanes.still(2999)).toBeNull();
    expect(lanes.still(3000)?.lane).toBe(0);
  });
});
