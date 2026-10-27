import { describe, expect, test } from "bun:test";

import { frameLook, hamming, LOOK_SIZE, summarize } from "./cm-look";

/** 縮めたコマから取る手がかり (`cm-look.ts`)。コマは合成したもの */

/** 明るさを `at(x, y)` で描いたコマ (色は U・V で一様) */
function frame(at: (x: number, y: number) => number, u = 128, v = 128) {
  const out = new Uint8Array(LOOK_SIZE);
  for (let y = 0; y < 18; y++)
    for (let x = 0; x < 32; x++) out[y * 32 + x] = at(x, y);
  out.fill(u, 576, 576 + 144);
  out.fill(v, 576 + 144);
  return out;
}

describe("1コマを読む", () => {
  test("右へ明るくなる絵は全部のビットが立ち、左へ明るくなる絵は 1 つも立たない", () => {
    const right = frameLook(frame((x) => x * 8));
    const left = frameLook(frame((x) => 255 - x * 8));
    expect([right.hi, right.lo]).toEqual([0xffffffff, 0xffffffff]);
    expect([left.hi, left.lo]).toEqual([0, 0]);
    expect(hamming(right, left)).toBe(64);
  });

  test("全体の明るさが変わっても、ハッシュは変わらない (局ごとの調整の違い)", () => {
    const art = (x: number, y: number) => ((x * 37 + y * 91) % 97) + 40;
    const a = frameLook(frame(art));
    const b = frameLook(frame((x, y) => art(x, y) + 20));
    expect(hamming(a, b)).toBe(0);
    expect(b.y - a.y).toBeCloseTo(20, 5);
  });

  test("色とコントラストも取る。一様なコマはコントラストが 0", () => {
    const look = frameLook(frame(() => 100, 90, 160));
    expect(look.u).toBe(90);
    expect(look.v).toBe(160);
    expect(look.contrast).toBe(0);
  });
});

describe("まとめる", () => {
  test("強い切れ目で場面を分け、真ん中のコマのハッシュを持つ。1 秒ごとの調子はその秒のコマの平均", () => {
    const looks = [
      ...Array.from({ length: 15 }, () => frameLook(frame((x) => x * 8))),
      ...Array.from({ length: 15 }, () => frameLook(frame((x) => 255 - x * 8))),
    ];
    const times = looks.map((_, i) => i / 10);
    // 弱い切れ目 (5) では分けない
    const cuts = looks.map((_, i) => (i === 15 ? 30 : i === 5 ? 5 : 0));
    const { shots, tone } = summarize(looks, times, cuts, 3);
    expect([...shots.start]).toEqual([0, 15]);
    expect([shots.hi[0], shots.hi[1]]).toEqual([0xffffffff, 0]);
    expect(tone.length).toBe(12);
    // 0 秒目は右へ明るい絵 (平均 124)、2 秒目は左へ明るい絵 (平均 131)。どちらもコントラストがある
    expect([tone[0], tone[8]]).toEqual([124, 131]);
    expect(tone[3]).toBe(74);
    expect(tone[11]).toBe(74);
  });

  test("コマの無い秒は前の秒の調子のまま", () => {
    const look = frameLook(frame(() => 50));
    const { tone } = summarize([look, look], [0, 0.5], [0, 0], 3);
    expect([...tone]).toEqual([
      50, 128, 128, 0, 50, 128, 128, 0, 50, 128, 128, 0,
    ]);
  });
});
