import { describe, expect, test } from "bun:test";

import { RecordingClock } from "./clock-recording";

describe("観る画面の時間の軸", () => {
  test("切り替えた所 → この場面 → 続きの位置の順に使い、切り替えた所とこの場面は 1 度で忘れる", () => {
    const clock = new RecordingClock(30, () => 600_000);
    clock.switchAt = 90;
    expect(clock.startFrom(3600)).toBe(90);
    // この場面も一緒に忘れる (切り替えた所から続けたので)
    expect(clock.startFrom(3600)).toBe(600);
    const scene = new RecordingClock(30, () => 600_000);
    expect(scene.startFrom(3600)).toBe(30);
    expect(scene.startFrom(3600)).toBe(600);
  });

  test("終わり近くまで観ていたら、続きにしない", () => {
    const clock = new RecordingClock(null, () => 3_599_000);
    expect(clock.startFrom(3600)).toBeNull();
    expect(clock.opening(3600)).toBeNull();
  });

  test("尺が分かったら、この場面から観る位置を先に出し、続きの位置なら「続きから」の印を付ける", () => {
    const clock = new RecordingClock(30, () => 600_000);
    expect(clock.opening(3600)).toEqual({ at: 30, continued: false });
    expect(clock.opening(3600)).toEqual({ at: 600, continued: true });
    expect(new RecordingClock(null, () => null).opening(3600)).toBeNull();
  });
});
