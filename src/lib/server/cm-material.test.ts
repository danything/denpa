import { describe, expect, test } from "bun:test";

import { type CmMaterial, decodeMaterial, encodeMaterial } from "./cm-material";

/** CM 検出の材料の控え (`cm-material.ts`) の書き出しと読み戻し */

function material(frames: number, logo = true): CmMaterial {
  const fps = 30000 / 1001;
  const times = Float64Array.from(
    { length: frames },
    (_, i) => 0.647956 + i / fps,
  );
  const cuts = Float32Array.from({ length: frames }, (_, i) =>
    i % 450 === 0 ? 42.5 : i % 97 === 0 ? 4.2 : 0.3,
  );
  const scores = Float32Array.from({ length: frames }, (_, i) =>
    i % 3000 < 2500 ? 0.7 : 0.05,
  );
  return {
    offset: 0.5,
    duration: frames / fps,
    fps,
    programLength: 1800,
    programStart: 9.5,
    silences: [
      { start: 10.1234, end: 10.9 },
      { start: 600, end: 600.6 },
    ],
    times,
    cuts,
    logo: logo ? { spans: [{ start: 10, end: 2500 }], scores } : null,
    why: logo ? "" : "ロゴの位置を特定できませんでした",
  };
}

describe("材料の控え", () => {
  test("書いて戻すと、時刻は µs、切れ目の点は 0.1、ロゴの点は 0.01 の目盛りで戻る", () => {
    const before = material(9000);
    const after = decodeMaterial(encodeMaterial(before))!;
    expect(after.offset).toBe(0.5);
    expect(after.programLength).toBe(1800);
    expect(after.programStart).toBe(9.5);
    expect(after.silences).toEqual(before.silences);
    expect(after.times.length).toBe(9000);
    for (let i = 0; i < 9000; i += 777)
      expect(Math.abs(after.times[i]! - before.times[i]!)).toBeLessThan(1e-6);
    // 弱すぎる切れ目 (3 未満) は持たない
    expect(after.cuts[0]).toBeCloseTo(42.5, 1);
    expect(after.cuts[97]).toBeCloseTo(4.2, 1);
    expect(after.cuts[1]).toBe(0);
    expect(after.logo!.spans).toEqual([{ start: 10, end: 2500 }]);
    expect(after.logo!.scores[0]).toBeCloseTo(0.7, 2);
    expect(after.logo!.scores[2600]).toBeCloseTo(0.05, 2);
  });

  test("ロゴが使えなかったものは理由ごと戻る", () => {
    const after = decodeMaterial(encodeMaterial(material(300, false)))!;
    expect(after.logo).toBeNull();
    expect(after.why).toBe("ロゴの位置を特定できませんでした");
  });

  test("壊れたものは読まない", () => {
    expect(decodeMaterial(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
