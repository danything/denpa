import { describe, expect, test } from "bun:test";

import {
  exitNative,
  fullscreenMode,
  nativeFullscreenElement,
  requestNative,
} from "./fullscreen";

const noop = async () => {};

describe("全画面への切り替え方", () => {
  test("標準の API があればそれ (PC・Android・iPadOS 16.4 以降)", () => {
    expect(
      fullscreenMode(
        { requestFullscreen: noop, webkitRequestFullscreen: noop },
        {},
      ),
    ).toBe("standard");
    expect(
      fullscreenMode({ requestFullscreen: noop }, { fullscreenEnabled: true }),
    ).toBe("standard");
  });

  test("プレフィックス付きしか無ければそれ (古い iPadOS)", () => {
    expect(fullscreenMode({ webkitRequestFullscreen: noop }, {})).toBe(
      "webkit",
    );
    expect(
      fullscreenMode(
        { webkitRequestFullscreen: noop },
        { webkitFullscreenEnabled: true },
      ),
    ).toBe("webkit");
  });

  test("どちらも無ければ枠を広げる (iPhone の Safari)", () => {
    expect(fullscreenMode({}, {})).toBe("pseudo");
  });

  test("API があっても使えないと言われたら次へ回す", () => {
    expect(
      fullscreenMode(
        { requestFullscreen: noop, webkitRequestFullscreen: noop },
        { fullscreenEnabled: false },
      ),
    ).toBe("webkit");
    expect(
      fullscreenMode(
        { requestFullscreen: noop, webkitRequestFullscreen: noop },
        { fullscreenEnabled: false, webkitFullscreenEnabled: false },
      ),
    ).toBe("pseudo");
  });

  test("いまの全画面はプレフィックス付きも見る", () => {
    const el = {} as Element;
    expect(nativeFullscreenElement({ fullscreenElement: el })).toBe(el);
    expect(
      nativeFullscreenElement({
        fullscreenElement: null,
        webkitFullscreenElement: el,
      }),
    ).toBe(el);
    expect(nativeFullscreenElement({})).toBeNull();
  });

  test("入る・出るは選んだ API を呼ぶ。失敗しても投げない", async () => {
    const called: string[] = [];
    const el = {
      requestFullscreen: async () => {
        called.push("standard");
        throw new Error("no activation");
      },
      webkitRequestFullscreen: () => {
        called.push("webkit");
        return undefined;
      },
    };
    await requestNative(el, "standard");
    await requestNative(el, "webkit");
    await requestNative(el, "pseudo");
    expect(called).toEqual(["standard", "webkit"]);

    const out: string[] = [];
    await exitNative({
      fullscreenElement: el,
      exitFullscreen: async () => void out.push("standard"),
    });
    await exitNative({
      webkitFullscreenElement: el,
      webkitExitFullscreen: () => void out.push("webkit"),
    });
    await exitNative({
      fullscreenElement: null,
      exitFullscreen: async () => void out.push("none"),
    });
    expect(out).toEqual(["standard", "webkit"]);
  });
});
