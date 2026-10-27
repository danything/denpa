import { describe, expect, test } from "bun:test";

import { repeatedRanges, shotsOf, type StoredShot } from "./cm-repeat";

/** よその局でも流れた区間の探し方 (`cm-repeat.ts`)。場面とハッシュは合成したもの */

/** 3 秒ずつの場面 (`hashes` は [上, 下])。秒 `from` から */
function mine(from: number, hashes: [number, number][]) {
  return hashes.map(([hi, lo], k) => ({
    start: from + k * 3,
    end: from + (k + 1) * 3,
    hi,
    lo,
    seq: k,
  }));
}

/** 集めておいた、ほかの録画の場面 (3 秒ずつ、順は `seq` から) */
function stored(recording: number, seq: number, hashes: [number, number][]) {
  return hashes.map(([hi, lo], k): StoredShot => ({
    recording,
    seq: seq + k,
    hi,
    lo,
    length: 3,
  }));
}

const A: [number, number] = [0x12345678, 0x9abcdef0];
const B: [number, number] = [0x0f0f0f0f, 0xf0f0f0f0];
const C: [number, number] = [0x55555555, 0xaaaaaaaa];
const D: [number, number] = [0x33333333, 0xcccccccc];

describe("よその局でも流れた区間", () => {
  test("2 つ続けて一致した場面の区間を返す", () => {
    expect(
      repeatedRanges(mine(100, [D, A, B, C]), stored(7, 40, [A, B])),
    ).toEqual([{ start: 103, end: 109 }]);
  });

  test("1 つだけの一致は数えない (たまたま似た絵)", () => {
    expect(repeatedRanges(mine(100, [A, C]), stored(7, 40, [A, B]))).toEqual(
      [],
    );
  });

  test("相手の録画で続いていない場面どうしは数えない", () => {
    const others = [...stored(7, 40, [A]), ...stored(7, 90, [B])];
    expect(repeatedRanges(mine(100, [A, B]), others)).toEqual([]);
  });

  test("3 ビットまでの違いは同じ場面。4 ビットは違う場面", () => {
    const near: [number, number] = [A[0] ^ 0b111, A[1]];
    const far: [number, number] = [A[0] ^ 0b1111, A[1]];
    expect(
      repeatedRanges(mine(0, [near, B]), stored(7, 0, [A, B])),
    ).toHaveLength(1);
    expect(repeatedRanges(mine(0, [far, B]), stored(7, 0, [A, B]))).toEqual([]);
  });

  test("長さが 0.1 秒より違えば違う場面", () => {
    const others = stored(7, 0, [A, B]).map((s) => ({ ...s, length: 3.2 }));
    expect(repeatedRanges(mine(0, [A, B]), others)).toEqual([]);
  });
});

describe("材料の場面", () => {
  test("のっぺりした場面と短すぎる場面は除き、順は除く前のものを持つ", () => {
    const times = Array.from({ length: 100 }, (_, i) => i / 10);
    const shots = shotsOf(
      {
        shots: {
          start: Uint32Array.of(0, 30, 32, 60),
          hi: Uint32Array.of(1, 2, 3, 4),
          lo: Uint32Array.of(0, 0, 0, 0),
          contrast: Uint8Array.of(40, 40, 40, 2),
        },
        tone: new Uint8Array(0),
      },
      times,
      10,
    );
    expect(shots.map((s) => [s.seq, s.start, s.end])).toEqual([
      [0, 0, 3],
      [2, 3.2, 6],
    ]);
  });
});
