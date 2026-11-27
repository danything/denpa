import { describe, expect, test } from "bun:test";

import { downmix } from "./downmix";

/** FFmpeg の `AV_CH_*` のビット */
const FL = 0x1;
const FR = 0x2;
const FC = 0x4;
const LFE = 0x8;
const BL = 0x10;
const BR = 0x20;
const BC = 0x100;
const SL = 0x200;
const SR = 0x400;

/** `count` 本のうち `at` 本目だけに 1 を置いた面 (2 標本) */
function only(count: number, at: number): Float32Array[] {
  return Array.from(
    { length: count },
    (_, i) => new Float32Array(i === at ? [1, 1] : [0, 0]),
  );
}

/** 並び `layout` の各チャンネルだけを鳴らしたときの、左右の大きさ */
function gains(layout: number, count: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => {
    const [l, r] = downmix(only(count, i), layout);
    return [l[0]!, r[0]!];
  });
}

/** Float32Array に入れた 1/√2 */
const H = Math.fround(Math.SQRT1_2);

describe("downmix", () => {
  test("1 本は両耳へ同じもの、2 本はそのまま (デュアルモノの左右も混ぜない)", () => {
    const mono = [new Float32Array([0.25])];
    expect(downmix(mono, FC)).toEqual([mono[0]!, mono[0]!]);
    const stereo = [new Float32Array([0.1]), new Float32Array([0.2])];
    const [l, r] = downmix(stereo, FL | FR);
    expect(l).toBe(stereo[0]!);
    expect(r).toBe(stereo[1]!);
  });

  test("5.1ch は ffmpeg の -ac 2 と同じ係数。中央は 1/√2 で左右へ、後ろは 1/√2 で同じ側へ、LFE は捨てる", () => {
    const expected: [number, number][] = [
      [1, 0],
      [0, 1],
      [H, H],
      [0, 0],
      [H, 0],
      [0, H],
    ];
    expect(gains(FL | FR | FC | LFE | BL | BR, 6)).toEqual(expected);
    expect(gains(FL | FR | FC | LFE | SL | SR, 6)).toEqual(expected);
  });

  test("ARIB の 3/0・2/1・3/1・2/2・3/2 も並びのとおりに下げる。後ろの中央は 1/2 で左右へ", () => {
    expect(gains(FL | FR | FC, 3)).toEqual([
      [1, 0],
      [0, 1],
      [H, H],
    ]);
    expect(gains(FL | FR | BC, 3)).toEqual([
      [1, 0],
      [0, 1],
      [0.5, 0.5],
    ]);
    expect(gains(FL | FR | FC | BC, 4)).toEqual([
      [1, 0],
      [0, 1],
      [H, H],
      [0.5, 0.5],
    ]);
    expect(gains(FL | FR | BL | BR, 4)).toEqual([
      [1, 0],
      [0, 1],
      [H, 0],
      [0, H],
    ]);
    expect(gains(FL | FR | FC | BL | BR, 5)).toEqual([
      [1, 0],
      [0, 1],
      [H, H],
      [H, 0],
      [0, H],
    ]);
  });

  test("正規化しない。全部が 1 なら左右は 1 + 1/√2 + 1/√2 (後ろのリミッタが抑える)", () => {
    const planes = Array.from({ length: 6 }, () => new Float32Array([1]));
    const [l, r] = downmix(planes, FL | FR | FC | LFE | BL | BR);
    expect(l[0]).toBeCloseTo(1 + 2 * H, 6);
    expect(r[0]).toBeCloseTo(1 + 2 * H, 6);
  });

  test("並びが分からない (0) か本数と合わないときは、AAC の channel_configuration の並びと見る", () => {
    expect(gains(0, 6)).toEqual(gains(FL | FR | FC | LFE | BL | BR, 6));
    expect(gains(FL | FR, 3)).toEqual(gains(FL | FR | FC, 3));
    expect(gains(0, 4)).toEqual(gains(FL | FR | FC | BC, 4));
    // 本数からも決まらなければ前の左右だけ
    expect(gains(0, 7).slice(2)).toEqual(
      Array.from({ length: 5 }, () => [0, 0]),
    );
  });
});
