import { describe, expect, test } from "bun:test";

import { Meter, METER_QUEUED } from "./meter";

/** `at` ms から `every` ms ごとに `bytes` バイトずつ、`count` 個届いたことにする。どれも回線から届くのを待って返った */
function feed(
  meter: Meter,
  at: number,
  count: number,
  every: number,
  bytes: number,
): number {
  let now = at;
  for (let i = 0; i < count; i++) {
    meter.add(bytes, now, now + every);
    now += every;
  }
  return now;
}

describe("受け取りの速さ (Meter)", () => {
  test("読んでいる間に届いた量を、読んでいた時間で割る。1 秒読むまでは値を返さない", () => {
    const meter = new Meter();
    // 100ms ごとに 25,000 バイト = 2 Mbit/s
    feed(meter, 0, 5, 100, 25_000);
    expect(meter.bps()).toBeNull();
    feed(meter, 500, 10, 100, 25_000);
    expect(meter.bps()).toBe(2_000_000);
  });

  test("窓は読んでいた時間で 5 秒ぶん。古い塊は外れる", () => {
    const meter = new Meter();
    let now = feed(meter, 0, 60, 100, 25_000);
    // 回線が半分になった
    now = feed(meter, now, 60, 100, 12_500);
    expect(meter.bps()).toBe(1_000_000);
  });

  test("先が埋まって読むのを止めている間は窓が進まず、最後に測った値を返す", () => {
    const meter = new Meter();
    const now = feed(meter, 0, 20, 100, 25_000);
    meter.pause();
    // 止めていた間に手元へ溜まっていたものは待たずに返る。数えない
    meter.add(500_000, now + 30_000, now + 30_000 + METER_QUEUED / 2);
    expect(meter.bps()).toBe(2_000_000);
    expect(meter.measuredAt).toBe(now);
  });

  test("止めたあとは、待って返った塊から先を数える。待つ前に溜まっていた塊は窓に入れない", () => {
    const meter = new Meter();
    let now = feed(meter, 0, 20, 100, 25_000);
    meter.pause();
    now += 10_000;
    meter.add(500_000, now, now + 1);
    // 待って返った 1 つ目は、待ち始めが分からないので時刻だけ控える
    meter.add(12_500, now + 1, now + 101);
    now = feed(meter, now + 101, 60, 100, 12_500);
    expect(meter.bps()).toBe(1_000_000);
    expect(meter.measuredAt).toBe(now);
  });
});
