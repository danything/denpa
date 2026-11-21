import { describe, expect, test } from "bun:test";

import type {
  NPTReference,
  NPTUpdatedMessage,
} from "@danything/arib/bml-protocol";

import { NptClock } from "./npt";

/** STC `stc` (90 kHz) で NPT `npt` (90 kHz)、速さ `scale` の参照を、時刻 `at` (ミリ秒) から使う */
function updated(
  at: number | undefined,
  options: {
    stc?: number;
    reference?: Partial<NPTReference> | null;
  } = {},
): NPTUpdatedMessage {
  const reference =
    options.reference === null
      ? null
      : {
          type: "nptReference" as const,
          postDiscontinuityIndicator: false,
          dsmContentId: 0,
          STCReference: 0,
          NPTReference: 0,
          scaleNumerator: 1,
          scaleDenominator: 1,
          ...options.reference,
        };
  return {
    type: "nptUpdated",
    componentId: 0x41,
    reference,
    stc: options.stc ?? reference?.STCReference ?? 0,
    ...(at === undefined ? {} : { timeUnixMillis: at }),
  };
}

describe("NPT", () => {
  test("参照が届くまでと、コマの時刻が分からないときは分からない", () => {
    const clock = new NptClock();
    expect(clock.at(1_000)).toBeNull();
    clock.update(updated(1_000), 1_000);
    expect(clock.at(null)).toBeNull();
  });

  test("参照の時刻からコマの時刻が進んだぶん進む。止めれば止まり、飛べば付いてくる", () => {
    const clock = new NptClock();
    // 時刻 10 秒のとき NPT 5 秒
    clock.update(updated(10_000, { reference: { NPTReference: 450_000 } }), 0);
    expect(clock.at(10_000)).toBe(5_000);
    expect(clock.at(12_500)).toBe(7_500);
    // 止めている間はコマの時刻が進まないので、NPT も同じ
    expect(clock.at(12_500)).toBe(7_500);
    // 先へ飛ぶ・戻る
    expect(clock.at(70_000)).toBe(65_000);
    expect(clock.at(11_000)).toBe(6_000);
    expect(clock.running(11_000)).toBe(true);
  });

  test("参照を使い始める STC が参照の STC より後なら、そのぶん進めた NPT から始める", () => {
    const clock = new NptClock();
    // STC 10 秒で NPT 0 の参照を、STC 13 秒 (時刻 100 秒) から使う
    clock.update(
      updated(100_000, {
        stc: 13 * 90_000,
        reference: { STCReference: 10 * 90_000 },
      }),
      0,
    );
    expect(clock.at(100_000)).toBe(3_000);
  });

  test("コマの時刻が参照の時刻に達するまでは、前の参照で答える", () => {
    const clock = new NptClock();
    clock.update(updated(0), 0);
    // 次の番組の参照 (NPT 0 から) が、映るより先に届いた
    clock.update(updated(60_000, { stc: 60 * 90_000 }), 5_000);
    expect(clock.at(59_000)).toBe(59_000);
    clock.update(
      updated(60_000, {
        stc: 60 * 90_000,
        reference: { STCReference: 60 * 90_000 },
      }),
      5_000,
    );
    expect(clock.at(59_000)).toBe(59_000);
    expect(clock.at(61_000)).toBe(1_000);
  });

  test("止まる参照 (0/1) のあいだは NPT_Reference のまま。運用されない速さと、無くなった NPT は分からない", () => {
    const clock = new NptClock();
    clock.update(
      updated(0, {
        reference: { NPTReference: 90_000, scaleNumerator: 0 },
      }),
      0,
    );
    expect(clock.at(30_000)).toBe(1_000);
    expect(clock.running(30_000)).toBe(false);
    clock.update(updated(40_000, { reference: { scaleNumerator: 2 } }), 0);
    expect(clock.at(41_000)).toBeNull();
    clock.update(updated(50_000), 0);
    clock.update(updated(60_000, { reference: null }), 0);
    expect(clock.at(55_000)).toBe(5_000);
    expect(clock.at(61_000)).toBeNull();
  });

  test("33 ビットで一周する", () => {
    const clock = new NptClock();
    clock.update(
      updated(0, { reference: { NPTReference: 2 ** 33 - 90_000 } }),
      0,
    );
    expect(clock.at(2_000)).toBe(1_000);
  });

  test("時刻の付いていない参照は、受け取ったときのコマの時刻から使う", () => {
    const clock = new NptClock();
    clock.update(updated(undefined), 7_000);
    expect(clock.at(8_000)).toBe(1_000);
    // コマの時刻も分からなければ捨てる
    clock.update(updated(undefined, { reference: null }), null);
    expect(clock.at(9_000)).toBe(2_000);
  });
});
