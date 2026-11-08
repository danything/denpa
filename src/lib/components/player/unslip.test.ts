import { describe, expect, test } from "bun:test";

import {
  SLIP_MOST,
  slipHidden,
  UNSLIP_EVERY,
  UNSLIP_STEP,
  unslipper,
} from "./unslip";

/** 再生位置と止まっているかだけ持つ `<video>` */
function fakeVideo(currentTime: number, paused = false, seeking = false) {
  return { currentTime, paused, seeking } as HTMLVideoElement;
}

describe("映像だけ遅れたら飛び直す", () => {
  test("映した 1 枚が 0.1 秒を超えて遅れたら、1 コマぶん前へ飛ぶ", () => {
    const video = fakeVideo(10);
    const fix = unslipper(() => 0);
    expect(fix.check(video, 10 - SLIP_MOST - 0.01)).toBe(true);
    expect(video.currentTime).toBeCloseTo(10 + UNSLIP_STEP, 6);
  });

  test("0.1 秒までの遅れと、映像が先にあるときは飛ばない", () => {
    const video = fakeVideo(10);
    const fix = unslipper(() => 0);
    expect(fix.check(video, 10 - SLIP_MOST)).toBe(false);
    expect(fix.check(video, 10.5)).toBe(false);
    expect(video.currentTime).toBe(10);
  });

  test("飛ぶのは 3 秒に 1 回まで", () => {
    let now = 0;
    const video = fakeVideo(10);
    const fix = unslipper(() => now);
    expect(fix.check(video, 9)).toBe(true);
    now = UNSLIP_EVERY - 1;
    expect(fix.check(video, 9)).toBe(false);
    now = UNSLIP_EVERY;
    expect(fix.check(video, 9)).toBe(true);
  });

  test("止めている間と、飛んでいる最中は飛ばない", () => {
    const fix = unslipper(() => 0);
    expect(fix.check(fakeVideo(10, true), 9)).toBe(false);
    expect(fix.check(fakeVideo(10, false, true), 9)).toBe(false);
  });

  test("`jump` は遅れを見ずに飛び、`check` と同じく 3 秒に 1 回まで", () => {
    let now = 0;
    const video = fakeVideo(10);
    const fix = unslipper(() => now);
    expect(fix.jump(video)).toBe(true);
    expect(video.currentTime).toBeCloseTo(10 + UNSLIP_STEP, 6);
    now = UNSLIP_EVERY - 1;
    expect(fix.check(video, 9)).toBe(false);
    expect(fix.jump(video)).toBe(false);
  });
});

describe("映像の遅れが見えない端末 (詰まったら測らずに飛ぶ)", () => {
  test("Windows は見えない", () => {
    expect(
      slipHidden({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
        userAgentData: { platform: "Windows" },
      }),
    ).toBe(true);
    expect(
      slipHidden({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0",
      }),
    ).toBe(true);
  });

  test("Android・Mac・iPhone は見える (映した 1 枚ごとの `check` が直す)", () => {
    expect(
      slipHidden({
        userAgent:
          "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
        userAgentData: { platform: "Android" },
      }),
    ).toBe(false);
    expect(
      slipHidden({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
      }),
    ).toBe(false);
    expect(
      slipHidden({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
      }),
    ).toBe(false);
  });

  test("navigator が無い (サーバで描くとき) は見えるとして扱う", () => {
    expect(slipHidden(undefined)).toBe(false);
  });
});
