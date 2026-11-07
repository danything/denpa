import { describe, expect, test } from "bun:test";

import { SLIP_MOST, UNSLIP_EVERY, UNSLIP_STEP, unslipper } from "./unslip";

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
});
