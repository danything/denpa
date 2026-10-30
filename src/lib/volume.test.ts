import { describe, expect, test } from "bun:test";

import {
  BOOST_DB,
  LIMITER,
  limiterTrim,
  MAX_LEVEL,
  stepLevel,
  storedVolume,
  tapVideo,
  throughAudio,
  volumeGain,
} from "./volume";

const db = (gain: number) => 20 * Math.log10(gain);

describe("音量", () => {
  test("覚えていなければ 100%。読めない値は 100%、範囲の外は端に寄せる", () => {
    expect(storedVolume(null)).toBe(MAX_LEVEL);
    expect(storedVolume("")).toBe(MAX_LEVEL);
    expect(storedVolume("abc")).toBe(MAX_LEVEL);
    expect(storedVolume("40")).toBe(40);
    expect(storedVolume("37.6")).toBe(38);
    expect(storedVolume("-5")).toBe(0);
    expect(storedVolume("250")).toBe(MAX_LEVEL);
    expect(storedVolume("0")).toBe(0);
  });

  test("100% は +6 dB、0% は無音、50% は 100% より 12 dB 小さい", () => {
    expect(BOOST_DB).toBe(6);
    expect(db(volumeGain(100))).toBeCloseTo(6, 6);
    expect(volumeGain(0)).toBe(0);
    expect(db(volumeGain(50))).toBeCloseTo(6 - 12.04, 1);
    // 上げるほど大きく、上限より上は上限のまま
    expect(volumeGain(30)).toBeLessThan(volumeGain(31));
    expect(volumeGain(150)).toBe(volumeGain(100));
  });

  test("↑↓ は 5% ずつ。刻みの途中からは次の刻みの目へ、端で止まる", () => {
    expect(stepLevel(100, 1)).toBe(100);
    expect(stepLevel(100, -1)).toBe(95);
    expect(stepLevel(0, -1)).toBe(0);
    expect(stepLevel(0, 1)).toBe(5);
    expect(stepLevel(42, 1)).toBe(45);
    expect(stepLevel(42, -1)).toBe(40);
  });

  /*
   * リミッタは当たらない音にも makeup gain を掛ける (Blink の作り)。後ろで打ち消して、
   * 当たらない音はつまみの値どおりにする。-3 dBFS・20:1 なら 0 dBFS は -0.15 dBFS で出て、
   * makeup は 2.85 × 0.6 = 1.71 dB
   */
  test("リミッタの後ろで、リミッタが足す大きさを打ち消す", () => {
    expect(db(limiterTrim(LIMITER))).toBeCloseTo(-1.71, 2);
    expect(LIMITER.knee).toBe(0);
    expect(LIMITER.ratio).toBe(20);
  });

  test("<audio> を通すのは、通したくて Safari でなくストリームを作れるときだけ", () => {
    const base = { wanted: true, session: false, streamable: true };
    expect(throughAudio(base)).toBe(true);
    expect(throughAudio({ ...base, wanted: false })).toBe(false);
    expect(throughAudio({ ...base, session: true })).toBe(false);
    expect(throughAudio({ ...base, streamable: false })).toBe(false);
  });

  test("<video> の音を Web Audio に通すのは、AudioContext が鳴らせるようになってから", () => {
    expect(tapVideo({ video: true, state: "running" })).toBe(true);
    expect(tapVideo({ video: true, state: "suspended" })).toBe(false);
    expect(tapVideo({ video: true, state: "interrupted" })).toBe(false);
    expect(tapVideo({ video: true, state: null })).toBe(false);
    expect(tapVideo({ video: false, state: "running" })).toBe(false);
  });
});
