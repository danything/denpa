import { describe, expect, test } from "bun:test";

import { CLOCK, WRAP } from "@danything/arib/pes";

import {
  HOLD_ABOVE,
  nextHold,
  rawChasePosition,
  RESUME_BELOW,
} from "./live-chase";

/** 追っかけを元の TS で受けるとき、サーバに送るのを止めさせるか (`nextHold`) */
describe("送るのを止めさせる (nextHold)", () => {
  test("手元が 20 秒を超えたら止めさせ、10 秒を切ったら続けさせる", () => {
    expect(nextHold(false, HOLD_ABOVE + 0.1, false)).toBe(true);
    expect(nextHold(true, RESUME_BELOW - 0.1, false)).toBe(false);
  });

  test("間 (10〜20 秒) では今のまま (行き来させない)", () => {
    for (const lead of [RESUME_BELOW, 15, HOLD_ABOVE]) {
      expect(nextHold(true, lead, false)).toBe(true);
      expect(nextHold(false, lead, false)).toBe(false);
    }
  });

  test("止めている間は手元が少なくても止めさせる", () => {
    expect(nextHold(false, 0, true)).toBe(true);
    expect(nextHold(true, 3, true)).toBe(true);
  });
});

/** 届いた PTS から通しの再生位置を出す (`rawChasePosition`) */
describe("元の TS の再生位置 (rawChasePosition)", () => {
  test("録画の先頭の PTS を引き、base を引いた秒", () => {
    const origin = 10 * CLOCK;
    expect(rawChasePosition(10 + 125, 120, origin)).toBeCloseTo(5);
    expect(rawChasePosition(10 + 125, 0, origin)).toBeCloseTo(125);
  });

  test("PTS が一周をまたいでも続けて数える (伸ばしてあっても、なくても)", () => {
    const origin = WRAP - 5 * CLOCK;
    // 先頭から 8 秒。一周を越えた PTS は 3 秒 (伸ばしたものは WRAP + 3 秒)
    expect(rawChasePosition(3, 0, origin)).toBeCloseTo(8);
    expect(rawChasePosition((WRAP + 3 * CLOCK) / CLOCK, 0, origin)).toBeCloseTo(
      8,
    );
  });
});
