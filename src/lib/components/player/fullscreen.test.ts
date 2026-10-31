import { describe, expect, test } from "bun:test";

import {
  exitNative,
  fullscreenMode,
  landscapeLock,
  nativeFullscreenElement,
  requestNative,
} from "./fullscreen";

const noop = async () => {};

describe("全画面の横向き固定", () => {
  test("横向きを要求し、終了時に解除する。同じ状態では繰り返さない", async () => {
    const calls: string[] = [];
    const orient = landscapeLock({
      lock: async (value: string) => void calls.push(value),
      unlock: () => void calls.push("unlock"),
    });
    orient(false);
    orient(true);
    orient(true);
    await Promise.resolve();
    expect(calls).toEqual(["landscape"]);
    orient(false);
    orient(false);
    expect(calls).toEqual(["landscape", "unlock"]);
  });

  test("API の欠如・拒否・同期例外は全画面の操作に伝えない", async () => {
    const apis = [
      undefined,
      {},
      {
        lock: async () => {
          throw new Error("unsupported");
        },
      },
      {
        lock: () => {
          throw new Error("denied");
        },
        unlock: () => {
          throw new Error("denied");
        },
      },
    ];
    for (const api of apis) {
      const orient = landscapeLock(api);
      expect(() => orient(true)).not.toThrow();
      await Promise.resolve();
      expect(() => orient(false)).not.toThrow();
    }
  });

  test("終了後に固定が完了しても解除する", async () => {
    let finish = () => {};
    let unlocked = 0;
    const orient = landscapeLock({
      lock: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      unlock: () => {
        unlocked++;
      },
    });
    orient(true);
    orient(false);
    expect(unlocked).toBe(1);
    finish();
    await Promise.resolve();
    expect(unlocked).toBe(2);
  });

  test("入り直していれば前の固定の完了で解除しない", async () => {
    const pending: (() => void)[] = [];
    let unlocked = 0;
    const orient = landscapeLock({
      lock: () =>
        new Promise<void>((resolve) => {
          pending.push(resolve);
        }),
      unlock: () => {
        unlocked++;
      },
    });
    orient(true);
    orient(false);
    orient(true);
    for (const finish of pending) finish();
    await Promise.resolve();
    expect(unlocked).toBe(1);
    orient(false);
    expect(unlocked).toBe(2);
  });
});

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
