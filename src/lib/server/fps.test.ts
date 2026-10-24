import { describe, expect, test } from "bun:test";

import {
  classifyWindow,
  fpsRepeat,
  fpsWeave,
  parseFieldDiffs,
  pickSmooth,
} from "./fps";

describe("コマ数の決め方 (フィールドを比べる)", () => {
  /** `seconds` 秒ぶんの列。`at` (何番目の値か → 値) で模様を作り、少し揺らす (同じ値が並ぶと中央値の試験にならない) */
  function series(
    seconds: number,
    perSec: number,
    at: (i: number) => number,
  ): number[] {
    return Array.from(
      { length: seconds * perSec },
      (_, i) => at(i) * (1 + 0.05 * Math.sin(i)),
    );
  }
  /** 3:2 のテレシネ: 上フィールドは5回に1回、前と同じ (差がほぼ 0) */
  const telecineTop = series(30, 30, (i) => (i % 5 === 4 ? 0.05 : 3));
  /** 60i・30p: 上フィールドは毎回違う */
  const movingTop = series(30, 30, () => 3);
  /** 30p: 同じコマの上下 (偶数番目) はほぼ同じ、コマをまたぐ差 (奇数番目) は大きい */
  const progressiveFields = series(30, 60, (i) => (i % 2 === 0 ? 0.9 : 3));
  /** 60i・テレシネ: 上下のフィールドはどれも違う */
  const movingFields = series(30, 60, () => 3);
  /** 静止画: どの差も動いているとみなす値に届かない */
  const still = (perSec: number) => series(30, perSec, () => 0.1);

  test("ffmpeg の出力から、名前ごとに差の列を拾う (先頭は前が無いので捨てる)", () => {
    const lines = [
      "[metadata@top @ 0x55] frame:0    pts:0   pts_time:0",
      "[metadata@top @ 0x55] lavfi.signalstats.YDIF=0",
      "[metadata@fields @ 0x66] lavfi.signalstats.YDIF=0",
      "[metadata@top @ 0x55] lavfi.signalstats.YDIF=24.3736",
      "[metadata@fields @ 0x66] lavfi.signalstats.YDIF=1.5",
      "[metadata@fields @ 0x66] lavfi.signalstats.YDIF=3",
      "[Parsed_metadata_3 @ 0x77] lavfi.signalstats.YDIF=99",
    ];
    expect(parseFieldDiffs(lines)).toEqual({
      top: [24.3736],
      fields: [1.5, 3],
    });
  });

  test("繰り返し (rep): テレシネは低く、毎回違うフィールドは 1 に近い", () => {
    const telecine = fpsRepeat(telecineTop);
    expect(telecine.value).toBeLessThan(0.1);
    expect(telecine.seconds).toBe(30);
    expect(fpsRepeat(movingTop).value).toBeGreaterThan(0.85);
  });

  test("繰り返し (rep): 編集点で位相がずれても、ずれた秒以外は低いまま", () => {
    // 10.4 秒のところで繰り返しの位相が2つずれる
    const shifted = series(30, 30, (i) =>
      (i < 312 ? i : i + 2) % 5 === 4 ? 0.05 : 3,
    );
    expect(fpsRepeat(shifted).value).toBeLessThan(0.1);
  });

  test("上下の差 (wr): 30p は低く、60i・テレシネは 1 に近い", () => {
    expect(fpsWeave(progressiveFields).value).toBeLessThan(0.35);
    expect(fpsWeave(movingFields).value).toBeGreaterThan(0.85);
  });

  test("動いていない秒は数えない。足りなければ測れない", () => {
    expect(fpsRepeat(still(30))).toEqual({ value: Number.NaN, seconds: 0 });
    expect(fpsWeave(still(60)).seconds).toBe(0);
    // 4秒だけ動いた窓は判定しない (5秒から)
    const fewTop = [
      ...telecineTop.slice(0, 4 * 30),
      ...still(30).slice(4 * 30),
    ];
    expect(
      classifyWindow(fpsRepeat(fewTop), fpsWeave(movingFields)),
    ).toBeNull();
  });

  test("窓を分ける: テレシネは 24p、30p は 30p、それ以外は 60i", () => {
    expect(classifyWindow(fpsRepeat(telecineTop), fpsWeave(movingFields))).toBe(
      "24p",
    );
    expect(
      classifyWindow(fpsRepeat(movingTop), fpsWeave(progressiveFields)),
    ).toBe("30p");
    expect(classifyWindow(fpsRepeat(movingTop), fpsWeave(movingFields))).toBe(
      "60i",
    );
  });

  test("窓を分ける: 境目は本番の実測の間 (rep 0.45 / wr 0.5)", () => {
    const s = (value: number) => ({ value, seconds: 29 });
    // アニメ本編の最大 rep 0.42 は 24p、実写の 60i (rep 0.83〜0.93 / wr 0.87〜0.97) は 60i
    expect(classifyWindow(s(0.42), s(0.95))).toBe("24p");
    expect(classifyWindow(s(0.83), s(0.87))).toBe("60i");
    expect(classifyWindow(s(0.45), s(0.5))).toBe("60i");
    // 30p の最大 wr 0.40 は 30p
    expect(classifyWindow(s(0.89), s(0.4))).toBe("30p");
    expect(classifyWindow(s(0.9), s(0.49))).toBe("30p");
  });

  test("多数決: 24p 系と 30p は 30コマ、60i は 60コマ", () => {
    expect(pickSmooth(["24p", "24p", "24p", "24p", "24p"])).toBe(false);
    expect(pickSmooth(["30p", "30p", "30p", "30p", "30p"])).toBe(false);
    expect(pickSmooth(["60i", "60i", "60i", "60i", "60i"])).toBe(true);
  });

  test("多数決: CM などに2窓乗っても引きずられない", () => {
    // アニメの5窓のうち2窓が 60i の CM
    expect(pickSmooth(["24p", "60i", "24p", "60i", "24p"])).toBe(false);
    // 実写の5窓のうち2窓がフィルム撮りの CM と 30p の CM
    expect(pickSmooth(["60i", "24p", "60i", "30p", "60i"])).toBe(true);
  });

  test("迷ったら60コマ: 同数・測れた窓が無いときは 60", () => {
    expect(pickSmooth(["24p", "60i", null, "60i", "30p"])).toBe(true);
    expect(pickSmooth([null, null, null, null, null])).toBe(true);
    expect(pickSmooth([])).toBe(true);
    // 測れない窓は数えない
    expect(pickSmooth([null, "24p", null, null, null])).toBe(false);
  });
});
