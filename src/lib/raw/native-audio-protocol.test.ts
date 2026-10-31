import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { readFragment, readInit } from "../ts/fmp4";
import { audioPlan } from "./native-audio-protocol";
describe("別に鳴らす音は映像の時計に合わせる", () => {
  test("先のコマは出口の遅れのぶん早く予約する", () => {
    const p = audioPlan(10.2, 0.021, 10, 1, 50, 0.03)!;
    expect(p.when).toBeCloseTo(50.17, 8);
    expect(p.offset).toBe(0);
  });
  test("間に合わなかった頭は切り、過ぎたコマは捨てる", () => {
    const p = audioPlan(10, 0.04, 10.01, 1, 20, 0)!;
    expect(p.when).toBeCloseTo(20.005, 8);
    expect(p.offset).toBeCloseTo(0.015, 8);
    expect(p.duration).toBeCloseTo(0.025, 8);
    expect(audioPlan(9, 0.02, 10, 1, 20, 0)).toBeNull();
  });
  test("速さは予約にも切り取りにも掛ける", () => {
    expect(audioPlan(10.2, 0.04, 10, 2, 50, 0)!.when).toBeCloseTo(50.1, 8);
    expect(audioPlan(10, 0.04, 10.01, 2, 50, 0)!.offset).toBeCloseTo(0.02, 8);
  });
  test("壊れた値・進まない時計では予約しない", () => {
    for (const rate of [0, -1, NaN, Infinity])
      expect(audioPlan(0, 1, 0, rate, 0, 0)).toBeNull();
    expect(audioPlan(NaN, 1, 0, 1, 0, 0)).toBeNull();
    expect(audioPlan(0, 0, 0, 1, 0, 0)).toBeNull();
  });
});

for (const name of ["live-h264.mp4", "live-av1.mp4"]) {
  test(`音のトラックだけ読んでも時刻と中身は変わらない: ${name}`, () => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`../../../tests/fake/${name}`, import.meta.url)),
    );
    const tracks = readInit(bytes);
    const audio = tracks.find((t) => t.kind === "audio")!;
    const expected = readFragment(bytes, tracks).filter(
      (s) => s.track === audio.id,
    );
    const actual = readFragment(bytes, [audio]);
    expect(actual.length > 0).toBe(true);
    expect(actual).toEqual(expected);
  });
}
