import { describe, expect, test } from "bun:test";
import { RECORDING, scenes } from "../../../tests/fake/tuner-scenes";
import {
  type Assignable,
  assign,
  type Capacity,
  capacityOf,
  contentions,
  type Occupant,
  placements,
  settled,
  whole,
} from "./conflict";

function res(over: Partial<Assignable> & { id: number }): Assignable {
  return {
    start_at: 0,
    end_at: 60,
    priority: 2,
    type: "GR",
    channel: "T16",
    ...over,
  };
}

/**
 * 'GR+BS+CS' のように、1台ずつ受けられる種別を**エージェントが選ぶ順に**並べる。
 * 同じ並びのチューナーには同じ順位を付ける (エージェントがそう返す約束。docs/agent.md「選ぶ順の約束」)
 */
function tuners(...specs: string[]) {
  return capacityOf(
    specs.map((spec) => ({
      types: spec.split("+"),
      rank: specs.indexOf(spec),
    })),
  );
}

const GR2 = tuners("GR", "GR", "BS+CS", "BS+CS");

describe("assign", () => {
  test("チューナー台数に収まるものは全部採用する", () => {
    const { accepted, rejected } = assign(
      [res({ id: 1, channel: "T16" }), res({ id: 2, channel: "T21" })],
      GR2,
    );
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(0);
  });

  test("同じチャンネルならチューナーを共有するので何本でも入る", () => {
    const { rejected } = assign(
      [1, 2, 3, 4, 5].map((id) => res({ id, channel: "T16" })),
      GR2,
    );
    expect(rejected).toHaveLength(0);
  });

  test("台数を超える異なるチャンネルは競合にする", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, channel: "T16" }),
        res({ id: 2, channel: "T21" }),
        res({ id: 3, channel: "T23" }),
      ],
      GR2,
    );
    expect(accepted.map((a) => a.reservation.id).sort()).toEqual([1, 2]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reservation.id).toBe(3);
    expect(rejected[0]!.reason).toContain(
      "GR を受けられるチューナーが足りません",
    );
  });

  test("優先度が高いものを残す", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, channel: "T16", priority: 1 }),
        res({ id: 2, channel: "T21", priority: 1 }),
        res({ id: 3, channel: "T23", priority: 5 }),
      ],
      GR2,
    );
    expect(accepted.map((a) => a.reservation.id)).toContain(3);
    expect(rejected[0]!.reservation.priority).toBe(1);
  });

  test("時間が重ならなければ台数を消費しない", () => {
    const { rejected } = assign(
      [
        res({ id: 1, channel: "T16", start_at: 0, end_at: 60 }),
        res({ id: 2, channel: "T21", start_at: 0, end_at: 60 }),
        res({ id: 3, channel: "T23", start_at: 60, end_at: 120 }),
      ],
      GR2,
    );
    expect(rejected).toHaveLength(0);
  });

  test("種別ごとに台数を数える (GRが埋まっていてもBSは録れる)", () => {
    const { rejected } = assign(
      [
        res({ id: 1, channel: "T16" }),
        res({ id: 2, channel: "T21" }),
        res({ id: 3, type: "BS", channel: "BS11_0" }),
      ],
      GR2,
    );
    expect(rejected).toHaveLength(0);
  });

  test("台数が分からない種別は制限しない", () => {
    const { rejected } = assign(
      [1, 2, 3, 4].map((id) => res({ id, type: "CS", channel: `CS${id}` })),
      tuners("GR", "GR"),
    );
    expect(rejected).toHaveLength(0);
  });

  test("BS と CS は同じ衛星チューナーを取り合う", () => {
    const { rejected } = assign(
      [
        res({ id: 1, type: "BS", channel: "BS15_0" }),
        res({ id: 2, type: "CS", channel: "CS4" }),
      ],
      tuners("BS+CS"),
    );
    expect(rejected.map((r) => r.reservation.id)).toEqual([2]);
  });

  test("地上波も衛星も受けるチューナー (PX-MLT など) は、どちらかで1台", () => {
    const mixed = tuners("GR", "GR+BS+CS");
    // 地上波2つで2台とも埋まるので、衛星は入らない
    const full = assign(
      [
        res({ id: 1, channel: "T16" }),
        res({ id: 2, channel: "T21" }),
        res({ id: 3, type: "BS", channel: "BS15_0" }),
      ],
      mixed,
    );
    expect(full.rejected.map((r) => r.reservation.id)).toEqual([3]);
    // 地上波1つなら、兼用の1台が衛星に回る
    const room = assign(
      [
        res({ id: 1, channel: "T16" }),
        res({ id: 2, type: "BS", channel: "BS15_0" }),
      ],
      mixed,
    );
    expect(room.rejected).toHaveLength(0);
  });
});

describe("assign (前後マージン)", () => {
  const GR1 = tuners("GR");
  const MARGINS = { start: 10, end: 15 };

  /*
   * **番組はマージンに勝つ。** 22:00 終了 → 22:00 開始。番組の時刻だけ見ると
   * 重ならないが、前は +15 まで録り続け、後は -10 から録り始めるので実際は 25 重なる。
   *
   * 丸ごと落としていた頃は、**隣り合っているというだけで後ろが録れなかった**。
   * 前のマージンは「延びたときの保険」で、後ろの 15秒 は番組そのものなので、
   * 前に離してもらう
   */
  test("隣り合う番組は、前がマージンを離して両方録る", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, start_at: 0, end_at: 100, channel: "T16" }),
        res({ id: 2, start_at: 100, end_at: 200, channel: "T21" }),
      ],
      GR1,
      MARGINS,
    );
    expect(rejected).toHaveLength(0);
    const first = accepted.find((a) => a.reservation.id === 1);
    const second = accepted.find((a) => a.reservation.id === 2);
    // 前は番組の終わりで離す (マージン +15 を諦める)
    expect(first?.to).toBe(100);
    // 後ろは番組を丸ごと録れる (頭のマージンだけ諦める)
    expect(second?.from).toBe(100);
    expect(whole(first!)).toBe(true);
    expect(whole(second!)).toBe(true);
  });

  /*
   * **番組そのものが重なっているなら、譲れるのはそこまで。** 入るところまで
   * 録って、残りは諦める (`assign` の「入るところまで録る」)
   */
  test("番組が半分だけ重なるなら、空いている側だけ録る", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, start_at: 0, end_at: 100, channel: "T16", priority: 5 }),
        res({ id: 2, start_at: 50, end_at: 200, channel: "T21", priority: 1 }),
      ],
      GR1,
      MARGINS,
    );
    expect(rejected).toHaveLength(0);
    const later = accepted.find((a) => a.reservation.id === 2);
    // 優先度の低いほうが譲る。相手が番組を録り終える 100 から使う
    expect(later?.from).toBe(100);
    expect(later?.to).toBe(215);
    expect(whole(later!)).toBe(false);
  });

  test("同じチャンネルならマージンが重なってもチューナーは1台で足りる", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, start_at: 0, end_at: 100, channel: "T16" }),
        res({ id: 2, start_at: 100, end_at: 200, channel: "T16" }),
      ],
      GR1,
      MARGINS,
    );
    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(0);
    /*
     * 同じチャンネルで続くなら、マージンを削らずに重ねる。後ろは前の選局を共有するので、
     * 前が離れても同じチューナーを使い続け、止めてから使う間は生まれない (引き継ぎは要らない)
     */
    const [first, second] = [1, 2].map((id) =>
      accepted.find((a) => a.reservation.id === id),
    );
    expect(first?.to).toBe(115);
    expect(second?.from).toBe(90);
  });

  test("同じチャンネルで続く録画は、前が離れても後ろが同じチューナーに残る (兼用あり)", () => {
    // T21 が兼用に入り、同じチャンネルで続く。前が離れても後ろは兼用にいるので、衛星はその後から
    const { accepted } = assign(
      [
        res({ id: 1, channel: "T16", start_at: 0, end_at: 300 }),
        res({ id: 2, channel: "T21", start_at: 100, end_at: 200 }),
        res({ id: 3, channel: "T21", start_at: 200, end_at: 400 }),
        res({
          id: 4,
          type: "BS",
          channel: "BS11_0",
          start_at: 350,
          end_at: 500,
          priority: 1,
        }),
      ],
      tuners("GR", "GR+BS+CS"),
      MARGINS,
    );
    // T21 の尻のマージンは衛星の番組に負けるので、T21 の番組が終わる 400 から
    expect(accepted.find((a) => a.reservation.id === 4)?.from).toBe(400);
  });

  /*
   * **実機で出た例** (2026-09-02 深夜、地上波 2台)。
   *
   *     23:30 ─幼女戦記(MX)─ 00:00
   *     23:45 ────片田舎(テレ朝)──── 00:15
   *     00:00 ────落第賢者(MX)────────────── 00:30
   *     00:00 ────LV999(テレ東)───────────── 00:30
   *
   * 3チャンネル要るのは **00:00〜00:15 の15分だけ**。丸ごとで判断していた頃は
   * LV999 (優先度2) がまるまる録れず、落第賢者 (優先度1) だけが残っていた
   */
  test("重なりが番組の一部なら、優先度の低いほうが途中から録る", () => {
    const MIN = 60_000;
    const GR2 = tuners("GR", "GR");
    const { accepted, rejected } = assign(
      [
        res({
          id: 1,
          channel: "MX",
          start_at: 0,
          end_at: 30 * MIN,
          priority: 2,
        }),
        res({
          id: 2,
          channel: "EX",
          start_at: 15 * MIN,
          end_at: 45 * MIN,
          priority: 2,
        }),
        res({
          id: 3,
          channel: "MX",
          start_at: 30 * MIN,
          end_at: 60 * MIN,
          priority: 1,
        }),
        res({
          id: 4,
          channel: "TX",
          start_at: 30 * MIN,
          end_at: 60 * MIN,
          priority: 2,
        }),
      ],
      GR2,
      { start: 10_000, end: 15_000 },
    );
    expect(rejected).toHaveLength(0);
    const lv999 = accepted.find((a) => a.reservation.id === 4);
    const low = accepted.find((a) => a.reservation.id === 3);
    // 優先度2 のほうは丸ごと録れる
    expect(whole(lv999!)).toBe(true);
    // 優先度1 のほうが譲って、相手が離す 45分 から録る
    expect(whole(low!)).toBe(false);
    expect(low?.from).toBe(45 * MIN);
  });

  test("マージンぶん離れていれば競合しない", () => {
    const { accepted } = assign(
      [
        res({ id: 1, start_at: 0, end_at: 100, channel: "T16" }),
        res({ id: 2, start_at: 130, end_at: 200, channel: "T21" }),
      ],
      GR1,
      MARGINS,
    );
    expect(accepted).toHaveLength(2);
  });
});

/**
 * ルール画面のプレビューが出す「チューナーの取り合い」。
 *
 * 数え方は `assign` と同じ。ここだけズレると、画面が競合と言っているのに
 * スケジューラは通す (逆もある) ことになる。
 */
function occ(over: Partial<Occupant> & { programId: number }): Occupant {
  return {
    name: `番組${over.programId}`,
    serviceName: "局",
    type: "GR",
    channel: "T16",
    start_at: 0,
    end_at: 60,
    ...over,
  };
}

const NO_MARGIN = { start: 0, end: 0 };

function against(
  row: Occupant,
  others: Occupant[],
  capacity: Capacity,
): string[] {
  return (
    contentions([row, ...others], capacity, NO_MARGIN).get(row.programId) ?? []
  );
}

describe("チューナーの取り合い (プレビュー)", () => {
  test("種別が違えば取り合わない。衛星に地上波は出さない", () => {
    /*
     * 実機で出ていたやつ。チューナーは GR / BS・CS で別々に刺さっているのに、
     * 全部まとめて数えていたので衛星の番組に地上波の番組が並んでいた
     */
    const bs = occ({ programId: 1, type: "BS", channel: "BS15_0" });
    const gr = occ({ programId: 2, type: "GR", channel: "T16" });
    expect(against(bs, [gr], tuners("BS+CS"))).toEqual([]);
  });

  test("兼用のチューナーがあれば、地上波と衛星でも取り合う", () => {
    const bs = occ({ programId: 1, type: "BS", channel: "BS15_0" });
    const a = occ({ programId: 2, channel: "T16" });
    const b = occ({ programId: 3, channel: "T21" });
    expect(against(bs, [a, b], tuners("GR", "GR+BS+CS")).sort()).toEqual([
      "番組2 (局)",
      "番組3 (局)",
    ]);
    expect(against(bs, [a, b], tuners("GR", "GR", "GR+BS+CS"))).toEqual([]);
  });

  test("ほかの単位も同時に溢れていても、自分の単位の取り合いは出す", () => {
    const bs = occ({ programId: 1, type: "BS", channel: "BS15_0" });
    const cs = occ({ programId: 2, type: "CS", channel: "CS4" });
    const a = occ({ programId: 3, channel: "T16" });
    const b = occ({ programId: 4, channel: "T21" });
    // 地上波が先に並ぶ (地上波の組が先に足りないと分かる) ようにしてある
    expect(against(bs, [a, b, cs], tuners("GR", "BS+CS"))).toEqual([
      "番組2 (局)",
    ]);
  });

  test("ほかの単位だけが溢れているなら、空いている自分は競合にしない", () => {
    const bs = occ({ programId: 1, type: "BS", channel: "BS15_0" });
    const a = occ({ programId: 2, channel: "T16" });
    const b = occ({ programId: 3, channel: "T21" });
    expect(against(bs, [a, b], tuners("GR", "BS+CS"))).toEqual([]);
  });

  test("足りない単位の相手だけを名指しする", () => {
    const bs = occ({ programId: 1, type: "BS", channel: "BS15_0" });
    const cs = occ({ programId: 2, type: "CS", channel: "CS4" });
    const gr = occ({ programId: 3, channel: "T16" });
    expect(against(bs, [cs, gr], tuners("GR", "GR", "BS+CS"))).toEqual([
      "番組2 (局)",
    ]);
  });

  test("台数に収まっていれば、重なっていても出さない", () => {
    const mine = occ({ programId: 1, channel: "T16" });
    const other = occ({ programId: 2, channel: "T21" });
    // 地上波2台あるので、別チャンネル2番組は録れる
    expect(against(mine, [other], tuners("GR", "GR"))).toEqual([]);
    // 1台しかなければ取り合う
    expect(against(mine, [other], tuners("GR"))).toEqual(["番組2 (局)"]);
  });

  test("同じ物理チャンネルは1台で足りるので数にも名前にも入れない", () => {
    const mine = occ({ programId: 1, channel: "T16" });
    const sameCh = occ({ programId: 2, channel: "T16" });
    expect(against(mine, [sameCh], tuners("GR"))).toEqual([]);
  });

  test("足りないときは相手を全部返す", () => {
    const mine = occ({ programId: 1, channel: "T16" });
    const a = occ({ programId: 2, channel: "T21" });
    const b = occ({ programId: 3, channel: "T25" });
    expect(against(mine, [a, b], tuners("GR")).sort()).toEqual([
      "番組2 (局)",
      "番組3 (局)",
    ]);
  });

  test("互いに重なっていない相手を足し合わせない", () => {
    // 自分 0-60 / A 0-20 / B 40-60。同時に要るのは常に2チャンネルまで
    const mine = occ({ programId: 1, channel: "T16", start_at: 0, end_at: 60 });
    const a = occ({ programId: 2, channel: "T21", start_at: 0, end_at: 20 });
    const b = occ({ programId: 3, channel: "T25", start_at: 40, end_at: 60 });
    expect(against(mine, [a, b], tuners("GR", "GR"))).toEqual([]);
  });

  test("台数が分からないときは何も言わない", () => {
    const mine = occ({ programId: 1, channel: "T16" });
    const other = occ({ programId: 2, channel: "T21" });
    expect(against(mine, [other], [])).toEqual([]);
  });

  test("長さの無い番組はチューナーを使わない", () => {
    const mine = occ({ programId: 1, channel: "T16", start_at: 0, end_at: 60 });
    const empty = occ({
      programId: 2,
      channel: "T21",
      start_at: 30,
      end_at: 30,
    });
    expect(against(mine, [empty], tuners("GR"))).toEqual([]);
    expect(against(empty, [mine], tuners("GR"))).toEqual([]);
    /*
     * 終わりが始まりより前の番組も使わない。使ったまま残ると、後ろの番組の
     * 取り合いが「同じ単位の答え」の使い回しで消えてしまっていた
     */
    const broken = occ({
      programId: 3,
      channel: "T21",
      start_at: 40,
      end_at: 20,
    });
    const a = occ({ programId: 4, channel: "T22", start_at: 70, end_at: 90 });
    const b = occ({ programId: 5, channel: "T23", start_at: 70, end_at: 90 });
    expect(against(a, [broken, b], tuners("GR"))).toEqual(["番組5 (局)"]);
  });

  test("名指しするのは、相手がいちばん多い瞬間の相手を開始順に", () => {
    // 自分 0-60 / 10 分に1本、30 分と 35 分に1本ずつ。いちばん多いのは 35 分の2本
    const mine = occ({ programId: 1, channel: "T16", start_at: 0, end_at: 60 });
    const early = occ({
      programId: 2,
      channel: "T21",
      start_at: 10,
      end_at: 20,
    });
    const first = occ({
      programId: 3,
      channel: "T25",
      start_at: 30,
      end_at: 50,
    });
    const second = occ({
      programId: 4,
      channel: "T27",
      start_at: 35,
      end_at: 50,
    });
    // 渡す順は逆にしておく (並びは開始順で決まる)
    expect(against(mine, [second, first, early], tuners("GR"))).toEqual([
      "番組3 (局)",
      "番組4 (局)",
    ]);
  });

  test("名指しする数が同じなら、早い瞬間の相手", () => {
    const mine = occ({ programId: 1, channel: "T16", start_at: 0, end_at: 60 });
    const early = occ({
      programId: 2,
      channel: "T21",
      start_at: 10,
      end_at: 20,
    });
    const late = occ({
      programId: 3,
      channel: "T25",
      start_at: 30,
      end_at: 40,
    });
    expect(against(mine, [late, early], tuners("GR"))).toEqual(["番組2 (局)"]);
  });
});

/**
 * **エージェントの適合テストと同じ場面** (`tests/fake/tuner-scenes.ts`)。
 * あちらは本物のエージェントに開かせ、こちらは denpa のなぞり方で同じ答えになるかを見る。
 * どちらかだけ変わると、どちらかが落ちる
 */
describe("エージェントと同じ場面", () => {
  for (const scene of scenes) {
    test(scene.name, () => {
      const capacity = capacityOf(scene.tuners);
      // 予約として割り振るのは録画だけ。弱い相手は録画に譲る (約束) ので数えない
      const opens = scene.steps.flatMap((step, at) =>
        "open" in step && step.priority >= RECORDING ? [{ step, at }] : [],
      );
      const holds = opens.map(({ step, at }) => {
        // 読むのをやめるか、引き継がれた (`after` に名前が挙がった) ところで離れる
        const closed = scene.steps.findIndex(
          (s, i) =>
            i > at &&
            (("close" in s && s.close === step.open) ||
              ("open" in s && (s.after ?? []).includes(step.open))),
        );
        return {
          type: step.type,
          channel: step.channel,
          from: at,
          to: closed < 0 ? scene.steps.length : closed,
        };
      });
      expect(placements(holds, capacity)).toEqual(
        opens.map(({ step }) => step.rank),
      );
    });
  }
});

const MIN = 60_000;
const at = (h: number, m = 0) => (h * 60 + m) * MIN;
const MARGINS = { start: 10_000, end: 15_000 };
/** A: 地上波専用 / B: 兼用 */
const MIXED = tuners("GR", "GR+BS+CS");

describe("兼用のチューナーがあるとき (#668)", () => {
  /*
   * T16 を兼用、T21 を専用に入れれば録れるが、エージェントは先の予定を見ずに
   * T16 を専用に入れる。T21 は兼用に入り、23:30 の衛星は兼用を取れない
   */
  test("エージェントが選ばない割り振りを当てにしない (ケース1)", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, channel: "T16", start_at: at(21), end_at: at(23) }),
        res({ id: 2, channel: "T21", start_at: at(22), end_at: at(24) }),
        res({
          id: 3,
          type: "BS",
          channel: "BS01_0",
          start_at: at(23, 30),
          end_at: at(24, 30),
        }),
      ],
      MIXED,
      MARGINS,
    );
    expect(rejected).toHaveLength(0);
    expect(
      accepted
        .filter(whole)
        .map((a) => a.reservation.id)
        .sort(),
    ).toEqual([1, 2]);
    // 衛星は T21 が兼用を離す 24:00 から (T21 の尻のマージンは番組に負ける)
    const bs = accepted.find((a) => a.reservation.id === 3);
    expect(bs?.from).toBe(at(24));
    expect(bs?.to).toBe(at(24, 30) + MARGINS.end);
    expect(accepted.find((a) => a.reservation.id === 2)?.to).toBe(at(24));
  });

  /*
   * どの瞬間も2台で足りるが、番組の途中でチューナーを替えずに 22:15 の衛星を録る方法が無い
   */
  test("途中で替えずに割り振る方法が無い組は、チューナー不足にする (ケース2)", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, channel: "T16", start_at: at(21), end_at: at(22) }),
        res({
          id: 2,
          type: "BS",
          channel: "BS11_0",
          start_at: at(21),
          end_at: at(21, 30),
        }),
        res({
          id: 3,
          channel: "T21",
          start_at: at(21, 45),
          end_at: at(22, 45),
        }),
        res({
          id: 4,
          type: "BS",
          channel: "BS01_0",
          start_at: at(22, 15),
          end_at: at(22, 45),
        }),
      ],
      MIXED,
      MARGINS,
    );
    expect(
      accepted
        .filter(whole)
        .map((a) => a.reservation.id)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect(rejected.map((r) => r.reservation.id)).toEqual([4]);
    expect(rejected[0]?.reason).toContain(
      "BS/CS を受けられるチューナーが足りません",
    );
  });

  test("優先度の高い衛星が後ろにあれば、前の地上波が譲る", () => {
    const { accepted, rejected } = assign(
      [
        res({ id: 1, channel: "T16", start_at: at(21), end_at: at(22) }),
        res({
          id: 2,
          type: "BS",
          channel: "BS11_0",
          start_at: at(21),
          end_at: at(21, 30),
        }),
        res({
          id: 3,
          channel: "T21",
          start_at: at(21, 45),
          end_at: at(22, 45),
        }),
        res({
          id: 4,
          type: "BS",
          channel: "BS01_0",
          start_at: at(22, 15),
          end_at: at(22, 45),
          priority: 5,
        }),
      ],
      MIXED,
      MARGINS,
    );
    expect(rejected).toHaveLength(0);
    expect(
      accepted
        .filter(whole)
        .map((a) => a.reservation.id)
        .sort(),
    ).toEqual([1, 2, 4]);
    // T21 は専用が空く 22:00 から (T16 の尻のマージンは番組に負ける)
    expect(accepted.find((a) => a.reservation.id === 3)?.from).toBe(at(22));
  });

  test("選局を共有する相手が先に抜けても、残ったほうは同じチューナーを使い続ける", () => {
    const { accepted } = assign(
      [
        res({ id: 1, channel: "T21", start_at: at(20), end_at: at(21) }),
        res({
          id: 2,
          channel: "T16",
          start_at: at(20, 30),
          end_at: at(21, 30),
        }),
        res({ id: 3, channel: "T16", start_at: at(20, 45), end_at: at(23) }),
        res({
          id: 4,
          type: "BS",
          channel: "BS11_0",
          start_at: at(22),
          end_at: at(23, 30),
        }),
      ],
      MIXED,
      MARGINS,
    );
    // T16 は兼用に入り、相方が抜けた後もそこにいる。衛星は T16 が離す 23:00 から
    expect(accepted.find((a) => a.reservation.id === 4)?.from).toBe(at(23));
  });

  test("録画中のものは、入っているチューナーを終わるまで塞ぐ", () => {
    const bs = [
      res({
        id: 1,
        type: "BS",
        channel: "BS11_0",
        start_at: at(21),
        end_at: at(22),
      }),
    ];
    // 録画中の地上波が兼用のチューナーにいる。専用が空いていても、衛星はそれが終わるまで入れない
    const blocked = assign(bs, MIXED, MARGINS, [
      { type: "GR", channel: "T21", rank: 1, until: at(21, 30) },
    ]);
    expect(blocked.accepted[0]?.from).toBe(at(21, 30));
    // 専用のチューナーにいるなら邪魔しない
    const free = assign(bs, MIXED, MARGINS, [
      { type: "GR", channel: "T21", rank: 0, until: at(21, 30) },
    ]);
    expect(free.accepted.every(whole)).toBe(true);
  });

  /*
   * 割り振りは変わるところだけなぞり直して速くしてある (`Timeline`)。通したものを頭から素直に
   * なぞり直して (`placements`)、全員が最後まで1台のチューナーを使えることを確かめる
   */
  test("通したものは、約束どおりに頭からなぞっても全員使える", () => {
    let s = 3;
    const next = () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 31;
    };
    const channels = {
      GR: ["T16", "T21", "T22"],
      BS: ["BS11_0", "BS01_0"],
      CS: ["CS4"],
    };
    for (const capacity of [
      MIXED,
      tuners("GR", "BS+CS", "GR+BS+CS"),
      tuners("GR", "GR", "BS+CS", "GR+BS+CS"),
    ]) {
      for (let round = 0; round < 200; round++) {
        const list = Array.from({ length: 20 }, (_, id) => {
          const type =
            (["GR", "GR", "BS", "CS"] as const)[Math.floor(next() * 4)] ?? "GR";
          const start = Math.floor(next() * 16) * 15 * MIN;
          return res({
            id,
            type,
            channel:
              channels[type][Math.floor(next() * channels[type].length)] ??
              "T16",
            start_at: start,
            end_at: start + (1 + Math.floor(next() * 6)) * 15 * MIN,
            priority: Math.floor(next() * 3),
          });
        });
        const { accepted } = assign(list, capacity, MARGINS);
        const holds = accepted.map((a) => ({
          type: a.reservation.type,
          channel: a.reservation.channel,
          from: a.from,
          to: a.to,
        }));
        const placed = placements(holds, capacity);
        expect(
          holds.filter((h, i) => h.to > h.from && placed[i] === null),
        ).toEqual([]);
      }
    }
  });

  test("順位の分からないエージェントなら、台数不明として何も競合にしない", () => {
    expect(
      capacityOf([{ types: ["GR"], rank: 0 }, { types: ["GR", "BS", "CS"] }]),
    ).toEqual([]);
    // 無効にしたチューナーは順位が無くてよい
    expect(
      capacityOf([
        { types: ["GR"], rank: 0 },
        { types: ["GR"], disabled: true, rank: null },
      ]),
    ).toHaveLength(1);
  });
});

/**
 * **兼用の無い構成では、今までと答えが変わらない。** 受けられるチューナーがどれも同じなので、
 * 先にどのチューナーへ入ったかは後に響かず、瞬間ごとの台数を数えるのと同じになる
 */
describe("専用だけ・兼用だけの構成", () => {
  /** 決まった種から作る乱数 (落ちたときに同じ場面を再現できるように) */
  function random(seed: number) {
    let s = seed;
    return () => {
      s = (s * 1103515245 + 12345) % 2 ** 31;
      return s / 2 ** 31;
    };
  }
  const CHANNELS = {
    GR: ["T16", "T21", "T22", "T23"],
    BS: ["BS11_0", "BS03_0", "BS01_0"],
    CS: ["CS4"],
  };
  type Span = { reservation: Assignable; from: number; to: number };

  /** 瞬間ごとに、取り合う単位 (`poolOf`) で異なるチャンネルが台数に収まっているか */
  function fitsEachMoment(
    spans: Span[],
    poolOf: (type: string) => string,
    limits: Record<string, number>,
  ) {
    return spans.every(({ from: p }) => {
      const held = new Map<string, Set<string>>();
      for (const { reservation, from, to } of spans) {
        if (from > p || p >= to) continue;
        const pool = poolOf(reservation.type);
        held.set(
          pool,
          (held.get(pool) ?? new Set()).add(
            `${reservation.type}:${reservation.channel}`,
          ),
        );
      }
      return [...held].every(([pool, set]) => set.size <= (limits[pool] ?? 0));
    });
  }

  const configs = [
    {
      label: "専用だけ",
      capacity: tuners("GR", "GR", "BS+CS", "BS+CS"),
      poolOf: (type: string) => (type === "GR" ? "GR" : "BS/CS"),
      limits: { GR: 2, "BS/CS": 2 },
    },
    {
      label: "兼用だけ",
      capacity: tuners("GR+BS+CS", "GR+BS+CS", "GR+BS+CS"),
      poolOf: () => "*",
      limits: { "*": 3 },
    },
  ];
  for (const { label, capacity, poolOf, limits } of configs) {
    test(`${label}: 通したものはどの瞬間も台数に収まり、収まる組は丸ごと通る`, () => {
      const next = random(label.length + 1);
      for (let round = 0; round < 300; round++) {
        const list = Array.from({ length: 8 }, (_, id) => {
          const type =
            (["GR", "GR", "BS", "CS"] as const)[Math.floor(next() * 4)] ?? "GR";
          const start = Math.floor(next() * 12) * 15 * MIN;
          return res({
            id,
            type,
            channel:
              CHANNELS[type][Math.floor(next() * CHANNELS[type].length)] ??
              "T16",
            start_at: start,
            end_at: start + (1 + Math.floor(next() * 4)) * 15 * MIN,
            priority: Math.floor(next() * 3),
          });
        });
        const { accepted } = assign(list, capacity, MARGINS);
        expect(fitsEachMoment(accepted, poolOf, limits)).toBe(true);
        const all = list.map((r) => ({
          reservation: r,
          from: r.start_at - MARGINS.start,
          to: r.end_at + MARGINS.end,
        }));
        if (fitsEachMoment(all, poolOf, limits)) {
          expect(accepted.map((a) => [a.from, a.to])).toEqual(
            [...all]
              .sort(
                (a, b) =>
                  b.reservation.priority - a.reservation.priority ||
                  a.reservation.start_at - b.reservation.start_at ||
                  a.reservation.id - b.reservation.id,
              )
              .map((a) => [a.from, a.to]),
          );
        }
      }
    });
  }
});

describe("チューナーの取り合い (プレビュー、兼用のチューナー)", () => {
  test("先に終わった地上波のせいで兼用が埋まっていれば、衛星は取り合いになる (ケース1)", () => {
    const t16 = occ({
      programId: 1,
      channel: "T16",
      start_at: at(21),
      end_at: at(23),
    });
    const t21 = occ({
      programId: 2,
      channel: "T21",
      start_at: at(22),
      end_at: at(24),
    });
    const bs = occ({
      programId: 3,
      type: "BS",
      channel: "BS01_0",
      start_at: at(23, 30),
      end_at: at(24, 30),
    });
    const got = contentions([t16, t21, bs], MIXED, NO_MARGIN);
    expect(got.get(3)).toEqual(["番組2 (局)"]);
    expect(got.get(2)).toEqual(["番組3 (局)"]);
    // T16 は取り合いが起きた時刻にはもういない
    expect(got.get(1)).toBeUndefined();
  });

  test("どの瞬間も足りていても、途中で替えずに入れないなら取り合い (ケース2)", () => {
    const got = contentions(
      [
        occ({ programId: 1, channel: "T16", start_at: at(21), end_at: at(22) }),
        occ({
          programId: 2,
          type: "BS",
          channel: "BS11_0",
          start_at: at(21),
          end_at: at(21, 30),
        }),
        occ({
          programId: 3,
          channel: "T21",
          start_at: at(21, 45),
          end_at: at(22, 45),
        }),
        occ({
          programId: 4,
          type: "BS",
          channel: "BS01_0",
          start_at: at(22, 15),
          end_at: at(22, 45),
        }),
      ],
      MIXED,
      NO_MARGIN,
    );
    expect(got.get(4)).toEqual(["番組3 (局)"]);
    expect(got.get(1)).toBeUndefined();
  });

  test("録画中のものが入っているチューナーも数える", () => {
    const bs = occ({
      programId: 1,
      type: "BS",
      channel: "BS11_0",
      start_at: at(21),
      end_at: at(22),
    });
    const busy = [{ type: "GR", channel: "T21", rank: 1, until: at(21, 30) }];
    // 名指しする相手 (番組) はいないが、入れないことは分かる。予約の側 (`assign`) で頭が欠ける
    expect(contentions([bs], MIXED, NO_MARGIN, busy).get(1)).toBeUndefined();
    const other = occ({
      programId: 2,
      type: "CS",
      channel: "CS4",
      start_at: at(21),
      end_at: at(22),
    });
    expect(contentions([bs, other], MIXED, NO_MARGIN, [])).toEqual(
      new Map([
        [1, ["番組2 (局)"]],
        [2, ["番組1 (局)"]],
      ]),
    );
  });

  test("時間帯の頭は、誰も使っていない瞬間までさかのぼる", () => {
    const list = [
      occ({ programId: 1, channel: "T16", start_at: at(21), end_at: at(23) }),
      occ({ programId: 2, channel: "T21", start_at: at(22), end_at: at(24) }),
      occ({
        programId: 3,
        type: "BS",
        channel: "BS01_0",
        start_at: at(23, 30),
        end_at: at(24, 30),
      }),
      occ({ programId: 4, channel: "T16", start_at: at(25), end_at: at(26) }),
    ];
    expect(settled(list, NO_MARGIN, at(23, 30))).toBe(at(21));
    // 誰も使っていない瞬間なら、そこから
    expect(settled(list, NO_MARGIN, at(25))).toBe(at(25));
    expect(settled(list, NO_MARGIN, at(20))).toBe(at(20));
  });
});
