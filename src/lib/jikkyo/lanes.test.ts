import { describe, expect, test } from "bun:test";

import {
  laneCount,
  Lanes,
  lead,
  lineHeight,
  sizeScale,
  SPAN_MS,
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
  test("上の行から使い、前のコメントの尻尾が入りきるまで同じ行に入れない", () => {
    const lanes = new Lanes(2);
    // 幅 1000px の枠で、幅 200px のコメント。速さは 1000px / 4 秒
    const first = lanes.flow(0, 200, 1000, 20);
    expect(first).toEqual({
      lane: 0,
      duration: ((1000 + 200) / 1000) * SPAN_MS,
    });
    expect(lanes.flow(100, 200, 1000, 20)?.lane).toBe(1);
    // 尻尾 (200px + 間 20px) が入りきるのは 880ms 後
    expect(lanes.flow(800, 200, 1000, 20)).toBeNull();
    expect(lanes.flow(880, 200, 1000, 20)?.lane).toBe(0);
  });

  test("空いた行が無ければ捨てる (null)。飛んだら全部空ける", () => {
    const lanes = new Lanes(1);
    lanes.flow(0, 100, 1000, 20);
    expect(lanes.flow(1, 100, 1000, 20)).toBeNull();
    lanes.clear();
    expect(lanes.flow(1, 100, 1000, 20)?.lane).toBe(0);
  });

  test("枠の外も同じ速さで流れる。道のりが延びたぶん長く流れ、枠を渡る長さは変わらない", () => {
    const lanes = new Lanes(1);
    // 枠 1000px の右に 300px、左に 200px。速さは 1000px / 4 秒のまま
    const flow = lanes.flow(0, 100, 1000, 20, { right: 300, left: 200 });
    expect(flow).toEqual({
      lane: 0,
      duration: ((300 + 1000 + 200 + 100) / 1000) * SPAN_MS,
    });
    // 外の右の端から枠の右の端までは 1.2 秒。録画はこれだけ早く流し始める
    expect(lead(1000, 300)).toBeCloseTo(1200);
    expect(lead(1000, 0)).toBe(0);
    expect(lead(0, 300)).toBe(0);
  });

  test("行が空くのは、前の尻尾が枠の右の端を過ぎてから次の頭がそこへ着くとき (外から入っても重ならない)", () => {
    const lanes = new Lanes(1);
    const outside = { right: 300, left: 300 };
    // 頭が枠に着くのは 1200ms、尻尾 (200px + 間 20px) が枠の右の端を過ぎるのは 1200 + 880ms
    lanes.flow(0, 200, 1000, 20, outside);
    expect(lanes.flow(879, 200, 1000, 20, outside)).toBeNull();
    expect(lanes.flow(880, 200, 1000, 20, outside)?.lane).toBe(0);
  });

  test("外が縮んだ (光を消した) 直後は、枠の外にまだいる前のものを待つ", () => {
    const lanes = new Lanes(1);
    // 外 300px から入ったもの。尻尾が枠の右の端を過ぎるのは 2080ms
    lanes.flow(0, 200, 1000, 20, { right: 300, left: 0 });
    // 外が無くなると、次の頭は流し始めた時刻に枠に着く。それまで待つ
    expect(lanes.flow(2000, 200, 1000, 20)).toBeNull();
    expect(lanes.flow(2080, 200, 1000, 20)?.lane).toBe(0);
  });

  test("止めるものは 3 秒置いて空ける。上は上の行から、下は下の行から積み、流れるものとは別に数える", () => {
    const lanes = new Lanes(3);
    expect(lanes.hold(0, "top")).toEqual({ lane: 0, duration: 3000 });
    expect(lanes.hold(0, "bottom")).toEqual({ lane: 2, duration: 3000 });
    expect(lanes.hold(1, "bottom")?.lane).toBe(1);
    expect(lanes.hold(2, "top")).toBeNull();
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
