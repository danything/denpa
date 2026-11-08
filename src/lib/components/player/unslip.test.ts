import { describe, expect, test } from "bun:test";

import {
  BEHIND_SPAN,
  DecodeLag,
  DROP_SPAN,
  SLIP_MOST,
  slipHidden,
  SLIPPING_SPAN,
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

describe("飛んだ直後の 1 コマは測らない", () => {
  test("自分で飛んだあと、次の 1 コマは測らず、その次から測る", () => {
    const video = fakeVideo(10);
    const fix = unslipper(() => 0);
    expect(fix.check(video, 9)).toBe(true);
    // 飛ぶ前のコマの時刻が残っている。遅れに数えない
    expect(fix.measure(video, 1)).toBeNull();
    expect(fix.measure(video, video.currentTime - 0.05)).toBeCloseTo(0.05, 6);
  });

  test("シークを知らされたら (`seeked`)、次の 1 コマは測らない", () => {
    const video = fakeVideo(100);
    const fix = unslipper(() => 0);
    fix.seeked();
    // 8 秒前のコマの時刻 (Android のエミュレータで「映像の遅れ 最大」が 8016ms になった)
    expect(fix.measure(video, 92)).toBeNull();
    expect(fix.check(video, 92)).toBe(true);
  });

  test("シークの最中は測らず、終わった次の 1 コマも測らない", () => {
    const state = { currentTime: 100, paused: false, seeking: true };
    const video = state as unknown as HTMLVideoElement;
    const fix = unslipper(() => 0);
    expect(fix.measure(video, 50)).toBeNull();
    state.seeking = false;
    expect(fix.measure(video, 50)).toBeNull();
    expect(fix.measure(video, 99.99)).toBeCloseTo(0.01, 6);
  });
});

describe("デコードが追いついていないか (`DecodeLag`)", () => {
  test("測った遅れで 15 秒に 3 回飛んだら追いついていない。2 回までと、古いものは数えない", () => {
    const lag = new DecodeLag();
    lag.jumped(0);
    lag.jumped(3_000);
    expect(lag.behind(3_000)).toBe(false);
    lag.jumped(6_000);
    expect(lag.behind(6_000)).toBe(true);
    // 最初の 1 回が 15 秒より古くなれば、また 2 回
    expect(lag.behind(BEHIND_SPAN + 1)).toBe(false);
  });

  test("捨てたコマが 10 秒で 2 割を超えたら追いついていない。Windows Edge の 5.6% では数えない", () => {
    const lag = new DecodeLag();
    lag.frames(0, 0, 0);
    // 30 コマ/秒で 10 秒、5.6% 捨てた
    lag.frames(DROP_SPAN, 300, 17);
    expect(lag.behind(DROP_SPAN)).toBe(false);
    // 次の 10 秒で半分捨てた (エミュレータの AV1 1080p)
    lag.frames(2 * DROP_SPAN, 600, 167);
    expect(lag.behind(2 * DROP_SPAN)).toBe(true);
  });

  test("コマが少ない間 (止めていた・裏) は、捨てた割合を数えない", () => {
    const lag = new DecodeLag();
    lag.frames(0, 0, 0);
    lag.frames(DROP_SPAN, 20, 10);
    expect(lag.behind(DROP_SPAN)).toBe(false);
  });

  test("遅れたあと 5 秒は再生を速めない", () => {
    const lag = new DecodeLag();
    expect(lag.slipping(0)).toBe(false);
    lag.late(1_000);
    expect(lag.slipping(1_000 + SLIPPING_SPAN - 1)).toBe(true);
    expect(lag.slipping(1_000 + SLIPPING_SPAN)).toBe(false);
  });

  test("作り直したら前の段のぶんを持ち越さない", () => {
    const lag = new DecodeLag();
    for (const at of [0, 3_000, 6_000]) lag.jumped(at);
    lag.reset();
    expect(lag.behind(6_000)).toBe(false);
    expect(lag.slipping(6_000)).toBe(false);
  });
});
