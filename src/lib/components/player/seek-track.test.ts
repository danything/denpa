import { describe, expect, test } from "bun:test";

import { playedIn, trackParts } from "./seek-track";

describe("シークバーの溝の区切り", () => {
  test("CM の端で区切り、CM の部分に印を付ける", () => {
    const spans = [
      { start: 0, end: 10 },
      { start: 50, end: 60 },
    ];
    expect(trackParts(spans, [], 0, 100)).toEqual([
      { from: 0, to: 0.1, cm: true },
      { from: 0.1, to: 0.5, cm: false },
      { from: 0.5, to: 0.6, cm: true },
      { from: 0.6, to: 1, cm: false },
    ]);
  });

  test("末尾の CM は溝の右端まで", () => {
    expect(trackParts([{ start: 90, end: 100 }], [], 0, 100).at(-1)).toEqual({
      from: 0.9,
      to: 1,
      cm: true,
    });
  });

  test("CM でない切れ目でも区切る", () => {
    expect(trackParts([], [25], 0, 100)).toEqual([
      { from: 0, to: 0.25, cm: false },
      { from: 0.25, to: 1, cm: false },
    ]);
  });

  test("幅の無いバーは1本、外れた区間・切れ目は捨てる", () => {
    const whole = [{ from: 0, to: 1, cm: false }];
    expect(trackParts([{ start: 0, end: 10 }], [5], 0, 0)).toEqual(whole);
    expect(trackParts([{ start: 200, end: 210 }], [0, 100], 0, 100)).toEqual(
      whole,
    );
  });

  test("始まりのずれたバー (ライブの戻れる範囲) でも比で置く", () => {
    expect(trackParts([{ start: 150, end: 175 }], [], 100, 200)).toEqual([
      { from: 0, to: 0.5, cm: false },
      { from: 0.5, to: 0.75, cm: true },
      { from: 0.75, to: 1, cm: false },
    ]);
  });
});

describe("部分の中で観たぶん", () => {
  const part = { from: 0.2, to: 0.6, cm: true };

  test("手前は 0、過ぎたら 1、中は割合", () => {
    expect(playedIn(part, 0.1)).toBe(0);
    expect(playedIn(part, 0.2)).toBe(0);
    expect(playedIn(part, 0.4)).toBe(0.5);
    expect(playedIn(part, 0.6)).toBe(1);
    expect(playedIn(part, Number.NaN)).toBe(0);
  });
});
