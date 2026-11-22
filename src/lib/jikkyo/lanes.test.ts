import { describe, expect, test } from "bun:test";

import {
  Lanes,
  lead,
  lineHeight,
  sizeScale,
  SPAN_MS,
  speedOf,
  textWidth,
} from "./lanes";

/*
 * コメントを流す場所の割り当て。長さは行の高さを 1 として数え、枠の高さは 14 (上下に半行ずつ余白)
 */

/** くじがいつも同じ値を返す、高さ 14 の枠 */
const fixed = (draw = 0, height = 14) => new Lanes(height, () => draw);

describe("大きさ", () => {
  test("行の高さは枠の 1/14 (下限 14px)", () => {
    expect(lineHeight(1080)).toBeCloseTo(1080 / 14);
    expect(lineHeight(100)).toBe(14);
  });

  test("半角は字の大きさの 0.55 倍、全角は 1 倍とみなす", () => {
    expect(textWidth("ab", 20)).toBeCloseTo(22);
    expect(textWidth("あい", 20)).toBe(40);
  });

  test("大きいものと小さいものの比はニコニコと同じ (普通 24・大 39・小 15)", () => {
    expect(sizeScale("big")).toBeCloseTo(1.625);
    expect(sizeScale("small")).toBeCloseTo(0.625);
    expect(sizeScale(undefined)).toBe(1);
  });
});

describe("流れるもの", () => {
  test("どれも枠を 4 秒で渡りきり、長いものほど速い (ニコニコと同じ)", () => {
    expect(speedOf(1000, 200)).toBeCloseTo(1200 / SPAN_MS);
    expect(speedOf(1000, 1000)).toBeCloseTo(2 * speedOf(1000, 0));
    const lanes = fixed();
    expect(lanes.flow(0, 200, 1000, 20)).toEqual({
      top: 0.5,
      duration: SPAN_MS,
    });
    expect(lanes.flow(0, 1000, 1000, 20)?.duration).toBeCloseTo(SPAN_MS);
  });

  test("上から積み、前のものの末尾が入りきるまで同じ高さに入れない", () => {
    const lanes = fixed();
    // 幅 1000px の枠で、幅 200px のコメント。速さは 1200px / 4 秒
    lanes.flow(0, 200, 1000, 20);
    expect(lanes.flow(100, 200, 1000, 20)?.top).toBe(1.5);
    // 末尾 (200px + 間 20px) が入りきるのは 733ms 後
    expect(lanes.flow(734, 200, 1000, 20)?.top).toBe(0.5);
  });

  test("決まった行は持たない。大きいものは高さぶん場所を取り、次のものはその下に積む", () => {
    const lanes = fixed();
    expect(lanes.flow(0, 200, 1000, 30, sizeScale("big"))?.top).toBe(0.5);
    expect(lanes.flow(0, 200, 1000, 20)?.top).toBeCloseTo(0.5 + 1.625);
    expect(lanes.flow(0, 200, 1000, 12, sizeScale("small"))?.top).toBeCloseTo(
      0.5 + 1.625 + 1,
    );
  });

  test("普通の大きさなら 13 件、大きいものなら 8 件まで縦に並ぶ。それより多いとくじの高さに重ねる", () => {
    const normal = fixed(0.5);
    for (let i = 0; i < 13; i++)
      expect(normal.flow(0, 200, 1000, 20)?.top).toBe(0.5 + i);
    // 余白の内 (0.5〜13.5) でくじ (0.5) を引く
    expect(normal.flow(0, 200, 1000, 20)?.top).toBeCloseTo(0.5 + 12 * 0.5);
    const big = fixed(0.5);
    for (let i = 0; i < 8; i++) big.flow(0, 200, 1000, 30, sizeScale("big"));
    expect(big.flow(0, 200, 1000, 30, sizeScale("big"))?.top).toBeCloseTo(
      0.5 + (13 - 1.625) * 0.5,
    );
  });

  test("重ねたものは空きに数えない。飛んだら全部空ける", () => {
    const lanes = fixed(0.99, 4);
    for (let i = 0; i < 3; i++) lanes.flow(0, 200, 1000, 20);
    // どこも埋まっている。くじ (0.99) で下のほうに重ねる
    expect(lanes.flow(1, 200, 1000, 20)?.top).toBeCloseTo(0.5 + 2 * 0.99);
    // 重ねたものは数えないので、空く時刻は前のまま
    expect(lanes.flow(734, 200, 1000, 20)?.top).toBe(0.5);
    lanes.clear();
    expect(lanes.flow(1, 200, 1000, 20)?.top).toBe(0.5);
  });

  test("あとから来た速いものが、前のものに枠の中で追い付く所には入れない", () => {
    const lanes = fixed();
    // 短いもの (幅 100px) は遅い。末尾 (と間) が左の端を出るのは 4073ms
    lanes.flow(0, 100, 1000, 20);
    // 長いもの (幅 1000px) は 2 倍の速さ。500ms に入ると 2500ms に左の端へ着き、前のものに追い付く
    expect(lanes.flow(500, 1000, 1000, 20)?.top).toBe(1.5);
    const again = fixed();
    again.flow(0, 100, 1000, 20);
    // 2100ms に入れば、左の端に着くのは前のものが出たあと
    expect(again.flow(2100, 1000, 1000, 20)?.top).toBe(0.5);
  });

  test("枠の幅が 0 なら流さない", () => {
    expect(fixed().flow(0, 100, 0, 20)).toBeNull();
  });

  test("枠の外もそのコメントの速さで流れる。道のりが延びたぶん長く流れ、枠を渡る長さは変わらない", () => {
    const lanes = fixed();
    // 枠 1000px の右に 300px、左に 200px。幅 100px のものの速さは 1100px / 4 秒
    const flow = lanes.flow(0, 100, 1000, 20, 1, { right: 300, left: 200 });
    expect(flow?.duration).toBeCloseTo(
      ((300 + 1000 + 200 + 100) / 1100) * SPAN_MS,
    );
    // 外の右の端から枠の右の端までは、幅 100px のもので 1.09 秒。幅 0 (いちばん遅い) で 1.2 秒
    expect(lead(1000, 100, 300)).toBeCloseTo((300 / 1100) * SPAN_MS);
    expect(lead(1000, 0, 300)).toBeCloseTo(1200);
    expect(lead(1000, 100, 0)).toBe(0);
    expect(lead(0, 100, 300)).toBe(0);
  });

  test("前の末尾が枠の右の端を過ぎてから次の先頭がそこへ着くなら同じ高さに入れる (外から入っても重ならない)", () => {
    const lanes = fixed();
    const outside = { right: 300, left: 300 };
    // 先頭が枠に着くのは 1000ms、末尾 (200px + 間 20px) が枠の右の端を過ぎるのは 1000 + 733ms
    lanes.flow(0, 200, 1000, 20, 1, outside);
    expect(lanes.flow(733, 200, 1000, 20, 1, outside)?.top).toBe(1.5);
    expect(lanes.flow(734, 200, 1000, 20, 1, outside)?.top).toBe(0.5);
  });

  test("外が縮んだ (光を消した) 直後は、枠の外にまだいる前のものを待つ", () => {
    const lanes = fixed();
    // 外 300px から入ったもの。末尾が枠の右の端を過ぎるのは 1733ms
    lanes.flow(0, 200, 1000, 20, 1, { right: 300, left: 0 });
    // 外が無くなると、次の先頭は流し始めた時刻に枠に着く。それまで待つ
    expect(lanes.flow(1700, 200, 1000, 20)?.top).toBe(1.5);
    expect(lanes.flow(1734, 200, 1000, 20)?.top).toBe(0.5);
  });

  test("枠の高さが変わっても、置いた場所は行の高さを 1 とした割合のまま", () => {
    const lanes = fixed();
    lanes.flow(0, 200, 1000, 20);
    lanes.resize(20);
    expect(lanes.flow(0, 200, 1000, 20)?.top).toBe(1.5);
  });
});

describe("止めるもの", () => {
  test("3 秒置いて空ける。上は上の端から、下は下の端から積み、流れるものとは別に数える", () => {
    const lanes = fixed(0.5, 4);
    expect(lanes.hold(0, "top")).toEqual({ top: 0.5, duration: 3000 });
    expect(lanes.hold(0, "bottom")).toEqual({ top: 2.5, duration: 3000 });
    expect(lanes.hold(1, "bottom").top).toBe(1.5);
    // 空いた所が無ければ、くじ (0.5) で真ん中に重ねる
    expect(lanes.hold(2, "top")).toEqual({ top: 1.5, duration: 3000 });
    expect(lanes.hold(3000, "top").top).toBe(0.5);
    // 流れるものの場所は空いたまま
    expect(lanes.flow(1, 100, 1000, 20)?.top).toBe(0.5);
  });

  test("大きいものは高さぶん取る。下に止めるものは下の端から上へ積む", () => {
    const lanes = fixed();
    expect(lanes.hold(0, "bottom", sizeScale("big")).top).toBeCloseTo(
      13.5 - 1.625,
    );
    expect(lanes.hold(0, "bottom").top).toBeCloseTo(13.5 - 1.625 - 1);
  });
});
