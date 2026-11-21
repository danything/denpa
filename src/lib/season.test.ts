import { describe, expect, test } from "bun:test";

import {
  ConfettiTrigger,
  countdown,
  decorated,
  greetingYear,
  hasNumbers,
  jstDate,
  nearestNewYear,
  newYearOf,
  spanWords,
  spiked,
  yearChip,
} from "./season";

/** 日本時間の日時 (unix ms) */
function jst(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  ms = 0,
): number {
  return Date.UTC(year, month - 1, day, hour - 9, minute, second, ms);
}

const EDGE = newYearOf(2027);

describe("日付は日本時間で決める", () => {
  test("UTC ではまだ 12 月 31 日でも、日本時間で 1 月 1 日なら 1 月 1 日", () => {
    expect(jstDate(Date.UTC(2026, 11, 31, 15, 0))).toEqual({
      year: 2027,
      month: 1,
      day: 1,
    });
  });
  test("年越しは日本時間の 1 月 1 日 0:00", () => {
    expect(EDGE).toBe(jst(2027, 1, 1));
    expect(new Date(EDGE).toISOString()).toBe("2026-12-31T15:00:00.000Z");
  });
  test("近いほうの年越しを選ぶ", () => {
    expect(nearestNewYear(jst(2026, 12, 31, 23, 59, 50))).toBe(EDGE);
    expect(nearestNewYear(jst(2027, 1, 1, 0, 0, 2))).toBe(EDGE);
    expect(nearestNewYear(jst(2027, 3, 1))).toBe(EDGE);
    expect(nearestNewYear(jst(2027, 8, 1))).toBe(newYearOf(2028));
  });
});

describe("カウントダウン", () => {
  test("23:59:50 から 10・9・8…、0:00 の手前で 1", () => {
    expect(countdown(jst(2026, 12, 31, 23, 59, 49, 999))).toBeNull();
    expect(countdown(jst(2026, 12, 31, 23, 59, 50))).toEqual({
      kind: "count",
      n: 10,
    });
    expect(countdown(jst(2026, 12, 31, 23, 59, 50, 1))).toEqual({
      kind: "count",
      n: 10,
    });
    expect(countdown(jst(2026, 12, 31, 23, 59, 51))).toEqual({
      kind: "count",
      n: 9,
    });
    expect(countdown(EDGE - 1)).toEqual({ kind: "count", n: 1 });
  });
  test("0:00 から 3 秒は「あけましておめでとうございます」、そのあとは何も出さない", () => {
    expect(countdown(EDGE)).toEqual({ kind: "greet" });
    expect(countdown(EDGE + 2_999)).toEqual({ kind: "greet" });
    expect(countdown(EDGE + 3_000)).toBeNull();
  });
  test("年越しから遠い日は何も出さない", () => {
    expect(countdown(jst(2026, 11, 21, 23, 59, 55))).toBeNull();
    expect(countdown(jst(2026, 12, 30, 23, 59, 55))).toBeNull();
  });
});

describe("ロゴの飾りは 1 月 1〜3 日", () => {
  test.each([
    ["12/31 23:59", jst(2026, 12, 31, 23, 59), false],
    ["1/1 0:00", jst(2027, 1, 1), true],
    ["1/3 23:59", jst(2027, 1, 3, 23, 59), true],
    ["1/4 0:00", jst(2027, 1, 4), false],
    ["2/1", jst(2027, 2, 1), false],
  ])("%s → %p", (_, at, want) => {
    expect(decorated(at)).toBe(want);
  });
});

describe("「denpa の 1 年」のチップは 1 月 1〜7 日に、その年にまだ閉じていなければ", () => {
  test("1 月 1〜7 日で、まだ閉じていない年ならその年", () => {
    expect(greetingYear(jst(2027, 1, 1), null)).toBe(2027);
    expect(greetingYear(jst(2027, 1, 7, 23, 59), 2026)).toBe(2027);
  });
  test("もう閉じた年・8 日から・12 月は出さない", () => {
    expect(greetingYear(jst(2027, 1, 2), 2027)).toBeNull();
    expect(greetingYear(jst(2027, 1, 8), null)).toBeNull();
    expect(greetingYear(jst(2026, 12, 31, 23, 59), null)).toBeNull();
  });
});

describe("紙吹雪", () => {
  test("跳ねたのは、前の 2 倍以上で 20 以上になったとき", () => {
    expect(spiked(10, 20)).toBe(true);
    expect(spiked(10, 19)).toBe(false);
    expect(spiked(0, 20)).toBe(true);
    expect(spiked(30, 59)).toBe(false);
    expect(spiked(30, 60)).toBe(true);
  });

  test("実況を開いていなければ、0:00 に 1 回だけ", () => {
    const trigger = new ConfettiTrigger();
    expect(trigger.feed(EDGE - 200, null)).toBe(false);
    expect(trigger.feed(EDGE + 100, null)).toBe(true);
    expect(trigger.feed(EDGE + 300, null)).toBe(false);
    // 3 秒を過ぎてから来たら降らせない (年越しの後に開いた)
    const late = new ConfettiTrigger();
    expect(late.feed(EDGE + 5_000, null)).toBe(false);
  });

  test("勢いが跳ねたら 1 回だけ。前の勢いは年越しの 90〜20 秒前のいちばん大きいもの", () => {
    const trigger = new ConfettiTrigger();
    expect(trigger.feed(EDGE - 60_000, 30)).toBe(false);
    expect(trigger.feed(EDGE - 30_000, 40)).toBe(false);
    // 40 の 2 倍に届かない
    expect(trigger.feed(EDGE - 5_000, 70)).toBe(false);
    expect(trigger.feed(EDGE + 2_000, 80)).toBe(true);
    expect(trigger.feed(EDGE + 4_000, 200)).toBe(false);
  });

  test("勢いが跳ねなければ降らせない (0:00 でも)", () => {
    const trigger = new ConfettiTrigger();
    expect(trigger.feed(EDGE - 60_000, 30)).toBe(false);
    for (let at = EDGE - 20_000; at < EDGE + 90_000; at += 1_000)
      expect(trigger.feed(at, 35)).toBe(false);
  });

  test("年越しから遠い時刻では、勢いが跳ねても降らせない", () => {
    const trigger = new ConfettiTrigger();
    expect(trigger.feed(jst(2027, 1, 1, 0, 5), 500)).toBe(false);
    expect(trigger.feed(jst(2026, 12, 31, 21), 500)).toBe(false);
  });

  test("年越しの後に開いても、勢いが跳ねていれば降らせる", () => {
    const trigger = new ConfettiTrigger();
    expect(trigger.feed(EDGE + 10_000, 120)).toBe(true);
  });
});

describe("「denpa の 1 年」の数", () => {
  const empty = {
    year: 2026,
    recorded: 0,
    recordedMs: 0,
    topRecorded: null,
    watched: 0,
    topWatched: null,
  };
  test("数が 1 つも無ければ無いことにする", () => {
    expect(hasNumbers(empty)).toBe(false);
    expect(hasNumbers(null)).toBe(false);
    expect(hasNumbers({ ...empty, watched: 1 })).toBe(true);
    expect(hasNumbers({ ...empty, topRecorded: "でんぱテレビ" })).toBe(true);
  });
  test("長さは 1 時間からは時間、満たなければ分", () => {
    expect(spanWords(300 * 3_600_000 + 1_000)).toBe("300 時間");
    expect(spanWords(45 * 60_000)).toBe("45 分");
  });
});

describe("「denpa の 1 年」のチップに書く年", () => {
  test("終わった前の年を数える (2027 年 1 月 1 日なら 2026 年)", () => {
    expect(yearChip(jst(2027, 1, 1), null)).toEqual({
      year: 2027,
      counted: 2026,
    });
    // UTC ではまだ 2026 年 12 月 31 日の 15 時
    expect(yearChip(Date.UTC(2026, 11, 31, 15), null)?.counted).toBe(2026);
    expect(yearChip(jst(2027, 1, 7, 23, 59), 2026)?.counted).toBe(2026);
  });
  test("年越しの前と、閉じた年は出さない", () => {
    expect(yearChip(jst(2026, 12, 31, 23, 59, 59), null)).toBeNull();
    expect(yearChip(jst(2027, 1, 2), 2027)).toBeNull();
  });
});
