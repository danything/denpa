import { describe, expect, test } from "bun:test";

import {
  LIVE_HANDOFF_LEAD,
  liveHandoff,
  type LiveHandoffState,
  type LiveHandoffStep,
  spareOffset,
} from "./live-handoff";

/** 表は 100 秒を再生中、裏は 98〜105 秒を持ち、101 秒で用意できている */
function state(patch: Partial<LiveHandoffState> = {}): LiveHandoffState {
  return {
    at: 100,
    target: 100 + LIVE_HANDOFF_LEAD,
    start: 98,
    end: 105,
    spareAt: 100 + LIVE_HANDOFF_LEAD,
    ready: true,
    ...patch,
  };
}

const WAIT: LiveHandoffStep = { kind: "wait" };
const SWITCH: LiveHandoffStep = { kind: "switch" };

describe("ライブの段を替えるときの受け渡し", () => {
  test("同じ放送時刻のコマが同じ位置になるように、裏の物差しを表の物差しに直す", () => {
    // 表は 10 秒の位置を 1000 ms に、裏は 2 秒の位置を 1500 ms に受け取った。裏の 2 秒は表の 10.5 秒
    const offset = spareOffset(
      { at: 10, unixMs: 1_000 },
      { at: 2, unixMs: 1_500 },
    );
    expect(2 + offset).toBeCloseTo(10.5);
  });

  test("裏が何も持っていないうちは待つ", () => {
    expect(
      liveHandoff(state({ target: null, start: null, end: null })),
    ).toEqual(WAIT);
  });

  test("裏が表の少し先を持ったら、そこで待たせる", () => {
    expect(liveHandoff(state({ target: null }))).toEqual({
      kind: "seat",
      to: 100 + LIVE_HANDOFF_LEAD,
    });
  });

  test("裏にまだ表の少し先が届いていなければ、届くのを待つ", () => {
    expect(liveHandoff(state({ target: null, end: 100.05 }))).toEqual(WAIT);
  });

  test("裏の先頭が表より先なら、先頭で待たせて表が来るのを待つ (間を飛ばさない)", () => {
    expect(liveHandoff(state({ target: null, start: 104, end: 108 }))).toEqual({
      kind: "seat",
      to: 104.05,
    });
    const seated = state({ target: 104.05, spareAt: 104.05, end: 108 });
    expect(liveHandoff(seated)).toEqual(WAIT);
    expect(liveHandoff({ ...seated, at: 104.04 })).toEqual(SWITCH);
  });

  test("裏が用意できていても、表が待たせた位置に来るまでは入れ替えない", () => {
    expect(liveHandoff(state())).toEqual(WAIT);
    expect(liveHandoff(state({ at: 100 + LIVE_HANDOFF_LEAD - 0.01 }))).toEqual(
      SWITCH,
    );
  });

  test("裏がデコードできていない・位置に着いていないうちは入れ替えない", () => {
    const at = 100 + LIVE_HANDOFF_LEAD;
    expect(liveHandoff(state({ at, ready: false }))).toEqual(WAIT);
    expect(liveHandoff(state({ at, spareAt: 100.5 }))).toEqual(WAIT);
  });

  test("表が待たせた位置を過ぎたら (裏が間に合わなかった)、いまの位置の先で待たせ直す", () => {
    expect(liveHandoff(state({ at: 102, ready: false }))).toEqual({
      kind: "seat",
      to: 102 + LIVE_HANDOFF_LEAD,
    });
  });
});
