import { describe, expect, test } from "bun:test";

import {
  laneCount,
  Lanes,
  lead,
  lineHeight,
  sizeScale,
  SPAN_MS,
  speedOf,
  textWidth,
} from "./lanes";

/*
 * コメントを流す行の割り当て
 */

describe("行の大きさ", () => {
  test("行の高さは枠の 1/14 (下限 14px)。上下に余白を残しておよそ 13 行", () => {
    expect(lineHeight(1080)).toBeCloseTo(1080 / 14);
    expect(lineHeight(100)).toBe(14);
    expect(laneCount(1080)).toBe(13);
  });

  test("半角は字の大きさの 0.55 倍、全角は 1 倍とみなす", () => {
    expect(textWidth("ab", 20)).toBeCloseTo(22);
    expect(textWidth("あい", 20)).toBe(40);
  });
});

describe("Lanes", () => {
  /** くじがいつも同じ値を返す行 */
  const fixed = (count: number, draw = 0) => new Lanes(count, () => draw);

  test("どれも枠を 4 秒で渡りきり、長いものほど速い (ニコニコと同じ)", () => {
    expect(speedOf(1000, 200)).toBeCloseTo(1200 / SPAN_MS);
    expect(speedOf(1000, 1000)).toBeCloseTo(2 * speedOf(1000, 0));
    const lanes = fixed(2);
    expect(lanes.flow(0, 200, 1000, 20)).toEqual({
      lane: 0,
      duration: SPAN_MS,
    });
    expect(lanes.flow(0, 1000, 1000, 20)?.duration).toBeCloseTo(SPAN_MS);
  });

  test("上の行から使い、前のコメントの末尾が入りきるまで同じ行に入れない", () => {
    const lanes = fixed(2);
    // 幅 1000px の枠で、幅 200px のコメント。速さは 1200px / 4 秒
    lanes.flow(0, 200, 1000, 20);
    expect(lanes.flow(100, 200, 1000, 20)?.lane).toBe(1);
    // 末尾 (200px + 間 20px) が入りきるのは 733ms 後
    expect(lanes.flow(734, 200, 1000, 20)?.lane).toBe(0);
  });

  test("あとから来た速いものが、前のものに枠の中で追い付く行には入れない", () => {
    const lanes = fixed(2);
    // 短いもの (幅 100px) は遅い。末尾 (と間) が左の端を出るのは 4073ms
    lanes.flow(0, 100, 1000, 20);
    // 長いもの (幅 1000px) は 2 倍の速さ。500ms に入ると 2500ms に左の端へ着き、前のものに追い付く
    expect(lanes.flow(500, 1000, 1000, 20)?.lane).toBe(1);
    const again = fixed(1);
    again.flow(0, 100, 1000, 20);
    // 2100ms に入れば、左の端に着くのは前のものが出たあと
    expect(again.flow(2100, 1000, 1000, 20)?.lane).toBe(0);
  });

  test("空いた行が無ければ、くじで選んだ行に重ねる。重ねたものは行の空きに数えない", () => {
    const lanes = fixed(3, 0.99);
    for (let i = 0; i < 3; i++) lanes.flow(0, 200, 1000, 20);
    // どの行も埋まっている。くじ (0.99) で最後の行に重ねる
    expect(lanes.flow(1, 200, 1000, 20)).toEqual({
      lane: 2,
      duration: SPAN_MS,
    });
    // 重ねたものは数えないので、空く時刻は前のまま
    expect(lanes.flow(734, 200, 1000, 20)?.lane).toBe(0);
    lanes.clear();
    expect(lanes.flow(1, 200, 1000, 20)?.lane).toBe(0);
  });

  test("枠の幅が 0 なら流さない", () => {
    expect(fixed(1).flow(0, 100, 0, 20)).toBeNull();
  });

  test("枠の外もそのコメントの速さで流れる。道のりが延びたぶん長く流れ、枠を渡る長さは変わらない", () => {
    const lanes = fixed(1);
    // 枠 1000px の右に 300px、左に 200px。幅 100px のものの速さは 1100px / 4 秒
    const flow = lanes.flow(0, 100, 1000, 20, { right: 300, left: 200 });
    expect(flow?.duration).toBeCloseTo(
      ((300 + 1000 + 200 + 100) / 1100) * SPAN_MS,
    );
    // 外の右の端から枠の右の端までは、幅 100px のもので 1.09 秒。幅 0 (いちばん遅い) で 1.2 秒
    expect(lead(1000, 100, 300)).toBeCloseTo((300 / 1100) * SPAN_MS);
    expect(lead(1000, 0, 300)).toBeCloseTo(1200);
    expect(lead(1000, 100, 0)).toBe(0);
    expect(lead(0, 100, 300)).toBe(0);
  });

  test("行が空くのは、前の末尾が枠の右の端を過ぎてから次の先頭がそこへ着くとき (外から入っても重ならない)", () => {
    const lanes = fixed(2);
    const outside = { right: 300, left: 300 };
    // 先頭が枠に着くのは 1000ms、末尾 (200px + 間 20px) が枠の右の端を過ぎるのは 1000 + 733ms
    lanes.flow(0, 200, 1000, 20, outside);
    expect(lanes.flow(733, 200, 1000, 20, outside)?.lane).toBe(1);
    expect(lanes.flow(734, 200, 1000, 20, outside)?.lane).toBe(0);
  });

  test("外が縮んだ (光を消した) 直後は、枠の外にまだいる前のものを待つ", () => {
    const lanes = fixed(2);
    // 外 300px から入ったもの。末尾が枠の右の端を過ぎるのは 1733ms
    lanes.flow(0, 200, 1000, 20, { right: 300, left: 0 });
    // 外が無くなると、次の先頭は流し始めた時刻に枠に着く。それまで待つ
    expect(lanes.flow(1700, 200, 1000, 20)?.lane).toBe(1);
    expect(lanes.flow(1734, 200, 1000, 20)?.lane).toBe(0);
  });

  test("止めるものは 3 秒置いて空ける。上は上の行から、下は下の行から積み、流れるものとは別に数える", () => {
    const lanes = fixed(3, 0.5);
    expect(lanes.hold(0, "top")).toEqual({ lane: 0, duration: 3000 });
    expect(lanes.hold(0, "bottom")).toEqual({ lane: 2, duration: 3000 });
    expect(lanes.hold(1, "bottom")?.lane).toBe(1);
    // 空いた行が無ければ、くじ (0.5) で真ん中の行に重ねる
    expect(lanes.hold(2, "top")).toEqual({ lane: 1, duration: 3000 });
    expect(lanes.hold(3000, "top")?.lane).toBe(0);
    // 流れるものの行は空いたまま
    expect(lanes.flow(1, 100, 1000, 20)?.lane).toBe(0);
  });

  test("大きいものは 1.25 倍、小さいものは 0.75 倍", () => {
    expect(sizeScale("big")).toBe(1.25);
    expect(sizeScale("small")).toBe(0.75);
    expect(sizeScale(undefined)).toBe(1);
  });
});
