import { describe, expect, test } from "bun:test";

import { Meter, METER_DRAIN_MOST, METER_QUEUED } from "./meter";

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
    // 100 ms ごとに 25,000 バイト = 2 Mbit/s
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
  test("止めたあと、読み出しが待たずに返り続けても (足すのに時間がかかる速い回線)、METER_DRAIN_MOST を過ぎたら数え始める", () => {
    const meter = new Meter();
    let now = feed(meter, 0, 20, 100, 25_000);
    meter.pause();
    now += 10_000;
    // 足すのに 20 ms かかり、その間に次の塊が届いている。読み出しは毎回 1 ms で返る (15 Mbit/s ほど)
    for (let i = 0; i < 400; i++) {
      meter.add(37_500, now, now + 1);
      now += 20;
    }
    expect(meter.measuredAt).not.toBeNull();
    expect(meter.measuredAt! > now - 1_000).toBe(true);
    expect(meter.bps()!).toBeCloseTo(15_000_000, -5);
    expect(METER_DRAIN_MOST).toBeLessThan(400 * 20);
  });

  test("メインスレッドが時々塞がっても、回線の速さより遅く見えない。塞がっていた間に届いた塊は、明けてからすぐ返る", () => {
    const meter = new Meter();
    // 回線は 10 ms ごとに 2,500 バイト = 2 Mbit/s。100 ms ごとに 120 ms 塞がる (データ放送・実況を描く処理など)
    let now = 0;
    let net = 0;
    meter.add(2_500, 0, 10);
    now = 10;
    net = 10;
    for (let round = 0; round < 40; round++) {
      // 塞がっていない 100 ms は届くのを待って読む
      for (let i = 0; i < 10; i++) {
        net += 10;
        meter.add(2_500, now, net);
        now = net;
      }
      // 120 ms 塞がる。その間に届いた 12 個は、明けてから待たずに 1 ms ずつで返る
      now += 120;
      for (let i = 0; i < 12; i++) {
        net += 10;
        meter.add(2_500, now, now + 1);
        now += 1;
      }
      // 読み切ったら、また回線から届くのを待つ
      net = Math.max(net, now);
    }
    expect(meter.bps()!).toBeGreaterThan(2_000_000 * 0.9);
  });
});
