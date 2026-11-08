import { describe, expect, test } from "bun:test";

import {
  HANDOFF_LEAD,
  HANDOFF_STUCK,
  handoff,
  type HandoffState,
  handoffTarget,
} from "./handoff";

/** 表は 100 秒を再生中、裏は 103 秒で用意できている */
function state(patch: Partial<HandoffState> = {}): HandoffState {
  return {
    ready: true,
    spareAt: 100 + HANDOFF_LEAD,
    target: 100 + HANDOFF_LEAD,
    at: 100,
    paused: false,
    stuckFor: 0,
    ...patch,
  };
}

const WAIT = { kind: "wait" };
const PLAY = { kind: "switch", play: true };

describe("段を替えるときの受け渡し", () => {
  test("表が進んでいれば先読みのぶん先で待たせ、止まっていれば表の位置で待たせる", () => {
    expect(handoffTarget(100, true)).toBe(100 + HANDOFF_LEAD);
    expect(handoffTarget(100, false)).toBe(100);
  });

  test("裏が用意できていても、表が待たせた位置に来るまでは入れ替えない", () => {
    expect(handoff(state())).toEqual(WAIT);
    const there = state({ at: 100 + HANDOFF_LEAD - 0.01 });
    expect(handoff(there)).toEqual(PLAY);
  });

  test("裏がデコードできていない・位置に着いていないうちは入れ替えない", () => {
    const at = 100 + HANDOFF_LEAD;
    expect(handoff(state({ at, ready: false }))).toEqual(WAIT);
    expect(handoff(state({ at, spareAt: 101 }))).toEqual(WAIT);
  });

  test("表が待たせた位置を過ぎたら (裏が間に合わなかった)、いまの位置の先で待たせ直す", () => {
    const late = state({ at: 104, ready: false });
    expect(handoff(late)).toEqual({ kind: "retarget", to: 104 + HANDOFF_LEAD });
  });

  test("表が後ろへ飛んだら待たせ直す", () => {
    const back = state({ at: 50 });
    expect(handoff(back)).toEqual({ kind: "retarget", to: 50 + HANDOFF_LEAD });
  });

  test("表を止めたら表の位置で待たせ直し、着いたら止めたまま入れ替える", () => {
    const paused = state({ paused: true });
    expect(handoff(paused)).toEqual({ kind: "retarget", to: 100 });
    const there = state({ paused: true, target: 100, spareAt: 100 });
    expect(handoff(there)).toEqual({ kind: "switch", play: false });
  });

  test("表が詰まっていれば表の位置で入れ替える。先で待たせていたら、しばらく詰まってから戻す", () => {
    // 詰まったところから用意した (回線が細くて段を下げるとき)
    const stuck = state({ stuckFor: 500, target: 100, spareAt: 100 });
    expect(handoff(stuck)).toEqual(PLAY);
    // 先で待たせている間に詰まった。すぐには戻さない
    expect(handoff(state({ stuckFor: 500 }))).toEqual(WAIT);
    const long = state({ stuckFor: HANDOFF_STUCK });
    expect(handoff(long)).toEqual({ kind: "retarget", to: 100 });
  });
});
