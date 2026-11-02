import { describe, expect, test } from "bun:test";

import {
  nextCarouselAttempt,
  OFF_PERIOD_RETRY,
  PERIOD_HOLD,
} from "./logo-period";

const HOUR = 60 * 60_000;
/** 2026-11-02 21:00 (日本時間) */
const NOW = Date.UTC(2026, 10, 2, 12, 0);

describe("衛星のロゴを待つ間合い", () => {
  test("一度も見ていなければ期間の外。開いたことがなければいま開く", () => {
    expect(nextCarouselAttempt({}, NOW)).toEqual({ period: false, at: NOW });
  });

  test("見てから 48 時間は期間中。空くたびに開く (譲って切れた直後でも)", () => {
    const seenAt = NOW - 47 * HOUR;
    expect(nextCarouselAttempt({ seenAt, triedAt: NOW - 1 }, NOW)).toEqual({
      period: true,
      at: NOW,
    });
  });

  test("48 時間経ったら期間の外。前に開いてから 7 時間あける", () => {
    const watch = { seenAt: NOW - PERIOD_HOLD, triedAt: NOW - HOUR };
    expect(nextCarouselAttempt(watch, NOW)).toEqual({
      period: false,
      at: NOW - HOUR + OFF_PERIOD_RETRY,
    });
  });

  test("見たあとに 20 分待って来なければ、48 時間経っていなくても期間は終わったとみなす", () => {
    const watch = {
      seenAt: NOW - 2 * HOUR,
      ranOutAt: NOW - HOUR,
      triedAt: NOW - 1.4 * HOUR,
    };
    expect(nextCarouselAttempt(watch, NOW)).toEqual({
      period: false,
      at: NOW - 1.4 * HOUR + OFF_PERIOD_RETRY,
    });
    // そのあと共有で見かけたら、また期間中
    expect(nextCarouselAttempt({ ...watch, seenAt: NOW - 1 }, NOW).period).toBe(
      true,
    );
  });

  test("期間の外で開く時刻は毎日ずれ、24 回で一日のどの時刻 (時) にも当たる", () => {
    const hours = new Set<number>();
    let at = NOW;
    for (let i = 0; i < 24; i++) {
      hours.add(new Date(at).getUTCHours());
      at = nextCarouselAttempt({ triedAt: at }, at).at;
    }
    expect(hours.size).toBe(24);
  });
});
