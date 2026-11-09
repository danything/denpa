import { describe, expect, test } from "bun:test";

import { measureVideoLoss } from "./video-loss";

describe("番組のうち映像が無かった長さ", () => {
  const SEC = 1000;
  /** 入れ物の先頭の放送時刻。番組はその 10 秒後から 30 分 */
  const head = 1_700_000_000_000;
  const recording = {
    ts_head: head,
    record_from: null,
    record_to: null,
    start_at: head + 10 * SEC,
    end_at: head + 1810 * SEC,
    finished_at: head + 1825 * SEC,
  };
  /** `from` 秒から `to` 秒まで 30 コマ/秒。`holes` の間は抜く */
  const frames = (from: number, to: number, holes: [number, number][] = []) =>
    Float64Array.from(
      Array.from(
        { length: Math.round((to - from) * 30) },
        (_, i) => from + i / 30,
      ).filter((t) => !holes.some(([a, b]) => t > a && t < b)),
    );

  test("映像が最後まであれば欠けは 0", () => {
    expect(
      measureVideoLoss({ times: frames(0, 1825), offset: 0 }, recording),
    ).toEqual({ span: 1800, lost: 0, tail: false });
  });

  test("途中で映像が止まったら、番組の終わりまでを欠けと数え、途中で切れたとする", () => {
    // 入れ物の先頭から 1140 秒で止まった。途中にも 3 秒の欠け
    const loss = measureVideoLoss(
      { times: frames(0, 1140, [[500, 503]]), offset: 0 },
      recording,
    );
    expect(loss?.tail).toBe(true);
    expect(loss?.span).toBe(1800);
    expect(loss?.lost).toBeCloseTo(1810 - 1140 + 3, 0);
  });

  test("マージンの所の欠けは数えない", () => {
    // 先頭の 10 秒 (前のマージン) と、番組の終わりより後ろに映像が無い
    expect(
      measureVideoLoss({ times: frames(10, 1810.1), offset: 0 }, recording),
    ).toEqual({ span: 1800, lost: 0, tail: false });
  });

  test("先頭を捨ててエンコードしたぶんは offset で戻す", () => {
    // 材料の時刻は入れ物の先頭から 0.5 秒捨てたもの
    expect(
      measureVideoLoss({ times: frames(0, 1824), offset: 0.5 }, recording),
    ).toEqual({ span: 1800, lost: 0, tail: false });
  });

  test("止めた所 (録り終えた時刻) から後ろと、チューナーを譲った所は数えない", () => {
    // 900 秒で止めた録画
    expect(
      measureVideoLoss(
        { times: frames(0, 900), offset: 0 },
        { ...recording, finished_at: head + 900 * SEC },
      ),
    ).toEqual({ span: 890, lost: 0, tail: false });
    // 末尾を 1200 秒で譲った録画
    expect(
      measureVideoLoss(
        { times: frames(0, 1200), offset: 0 },
        { ...recording, record_to: head + 1200 * SEC },
      ),
    ).toEqual({ span: 1190, lost: 0, tail: false });
  });

  test("コマが無い (映像の無い録画) なら測らない", () => {
    expect(
      measureVideoLoss({ times: new Float64Array(), offset: 0 }, recording),
    ).toBeNull();
  });
});
