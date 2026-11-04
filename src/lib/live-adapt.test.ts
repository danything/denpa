import { describe, expect, test } from "bun:test";

import { stepOrder } from "./adapt";
import type { Notice } from "./live";
import {
  LagMeter,
  LIGHT_NOTE,
  PROBE_LEAST,
  PROBE_MOST,
  probeBytes,
  probeRate,
  RATE_LEAST,
  RATE_WINDOW,
  replacesWarning,
  rungFields,
  servedStep,
  stepFields,
  Throughput,
} from "./live-adapt";

type Tuned = Extract<Notice, { type: "tuned" }>;

const tuned = (over: Partial<Tuned>): Tuned => ({
  type: "tuned",
  channelType: "GR",
  channel: "27",
  codecs: "",
  codec: "h264",
  raw: false,
  rung: 0,
  audio: "0",
  audios: [],
  ...over,
});

/** **段を変えてリクエストし直すときの指示** (`stepFields`・`rungFields`) */
describe("段の指示の組み立て", () => {
  test("段 0 は何も足さない (形式はメニューの選択どおり。家の中なら MPEG-2 のまま)", () => {
    expect(stepFields(0, ["av1", "h264"])).toEqual({});
  });

  test("段 1〜3 は段と再生できるコーデックを足し、放送のままを外す (家の中の MPEG-2 から変換へ移る)", () => {
    expect(stepFields(2, ["hevc", "h264"])).toEqual({
      rung: 2,
      playable: ["hevc", "h264"],
      raw: false,
    });
  });

  test("音声だけは codec: audio と、音声を 96k にする段 3", () => {
    expect(stepFields("audio", ["h264"])).toEqual({
      codec: "audio",
      rung: 3,
      raw: false,
    });
  });

  test("追っかけの指示には codec を足さない", () => {
    expect(rungFields(1, ["h264"])).toEqual({
      rung: 1,
      playable: ["h264"],
      raw: false,
    });
    expect(rungFields(0, ["h264"])).toEqual({});
  });
});

/** **`tuned` から読む段** (`servedStep`) */
describe("流れている段", () => {
  test("段を下げた変換はその段、音声だけは audio、放送のままは 0", () => {
    expect(servedStep(tuned({ rung: 2 }))).toBe(2);
    expect(servedStep(tuned({ codec: "audio", rung: 3 }))).toBe("audio");
    expect(servedStep(tuned({ raw: true, rung: 0 }))).toBe(0);
  });

  test("音声だけがいちばん軽い", () => {
    expect(stepOrder("audio")).toBeGreaterThan(stepOrder(3));
    expect(stepOrder(1)).toBeGreaterThan(stepOrder(0));
  });
});

/** **受け取りの速さ** (`Throughput`) */
describe("受け取りの速さ", () => {
  test("測り始めて少しの間は分からない", () => {
    const meter = new Throughput();
    meter.reset(0);
    meter.push(500, 100_000);
    expect(meter.rate(RATE_LEAST - 1)).toBeNull();
  });

  test("窓の中で受け取った量を bit/s にする", () => {
    const meter = new Throughput();
    meter.reset(0);
    // 1 秒に 125,000 バイト = 1 Mbit/s
    for (let at = 1_000; at <= 4_000; at += 1_000) meter.push(at, 125_000);
    expect(meter.rate(4_000)).toBe(1_000_000);
  });

  test("窓より古いものは数えない", () => {
    const meter = new Throughput();
    meter.reset(0);
    meter.push(1_000, 10_000_000);
    for (let at = 7_000; at <= 11_000; at += 1_000) meter.push(at, 125_000);
    expect(meter.rate(11_000)).toBe((5 * 125_000 * 8 * 1000) / RATE_WINDOW);
  });

  test("選局し直したら前のぶんは捨てて測り直す", () => {
    const meter = new Throughput();
    meter.reset(0);
    meter.push(3_000, 125_000);
    meter.reset(4_000);
    expect(meter.rate(5_000)).toBeNull();
  });
});

/** **`encode`・`pinned` の断り書きを、いまの断り書きの代わりに出すか** (`replacesWarning`) */
describe("断り書きの上書き", () => {
  const encode = "サーバのエンコードが追いつかないため、再生が止まります";

  test("何も出ていないときと、前に出した同じ文が残っているときは出す", () => {
    expect(replacesWarning("encode", "", null)).toBe(true);
    expect(replacesWarning("pinned", "", null)).toBe(true);
    expect(replacesWarning("encode", encode, encode)).toBe(true);
  });

  test("ほかの理由の断り書き (GPU から降りた・混んでいた) は上書きしない", () => {
    const busy = "サーバが混んでいるため、画質を下げられませんでした";
    expect(replacesWarning("encode", busy, null)).toBe(false);
    expect(replacesWarning("pinned", busy, null)).toBe(false);
  });

  test("サーバが軽くしたあとも遅れているなら、軽くしたという文をエンコードの遅れの文で替える", () => {
    expect(replacesWarning("encode", LIGHT_NOTE.half, null)).toBe(true);
    expect(replacesWarning("encode", LIGHT_NOTE.gpu, null)).toBe(true);
    // 手で選んでいて回線が足りないのは別の理由。軽くした文は残す
    expect(replacesWarning("pinned", LIGHT_NOTE.half, null)).toBe(false);
  });
});

/** **放送に対する遅れの伸び** (`LagMeter`)。実時間と、届いた映像の端の差がどれだけ伸びたか */
describe("放送に対する遅れ", () => {
  /** `rate` 倍の速さで届く映像の端を、0.5 秒ごとに `seconds` 秒ぶん渡す */
  function feed(meter: LagMeter, seconds: number, rate: number): number {
    let now = 0;
    for (; now <= seconds * 1000; now += 500)
      meter.push(now, (now / 1000) * rate);
    return now - 500;
  }

  test("届く速さが足りていれば伸びない", () => {
    const meter = new LagMeter();
    const now = feed(meter, 10, 1);
    expect(meter.growth(now)).toBeCloseTo(0);
  });

  test("足りなければ、足りないぶん伸びる (2/3 しか届かなければ 4 秒で 1.3 秒ほど)", () => {
    const meter = new LagMeter();
    const now = feed(meter, 10, 2 / 3);
    expect(meter.growth(now)!).toBeGreaterThan(1);
  });

  test("4 秒ぶん測れるまでは null", () => {
    const meter = new LagMeter();
    const now = feed(meter, 3, 1);
    expect(meter.growth(now)).toBeNull();
  });

  test("キーフレームの塊が遅れて届く揺れは、両端のいちばん小さい遅れどうしで比べるので数えない", () => {
    const meter = new LagMeter();
    let now = 0;
    for (; now <= 10_000; now += 250) {
      // 1 秒に 1 回、0.4 秒遅れて届く
      const late = now % 1_000 === 500 ? 0.4 : 0;
      meter.push(now, now / 1000 - late);
    }
    expect(Math.abs(meter.growth(now - 250)!)).toBeLessThan(0.1);
  });

  test("端が大きく戻ったら (別のストリーム)、前の値と比べない", () => {
    const meter = new LagMeter();
    feed(meter, 10, 1);
    meter.push(11_000, 0.5);
    expect(meter.growth(11_000)).toBeNull();
  });
});

/** **上げる前に取る試しのデータ** (`probeBytes`・`probeRate`) */
describe("試しのデータ", () => {
  test("流れている段のぶんを引いた残りを、1 秒ぶん取る。下限と上限に丸める", () => {
    // 6 Mbit/s 要って、いま 2 Mbit/s 流れている。残り 4 Mbit/s の 1 秒 = 500,000 バイト
    expect(probeBytes(6_000_000, 2_000_000)).toBe(500_000);
    expect(probeBytes(1_000_000, 2_000_000)).toBe(PROBE_LEAST);
    expect(probeBytes(1e9, 0)).toBe(PROBE_MOST);
  });

  test("最初の塊から最後の塊までで割る (最初の塊までは往復の待ち)", () => {
    expect(
      probeRate({
        startAt: 0,
        firstAt: 100,
        firstBytes: 10_000,
        lastAt: 1_100,
        bytes: 260_000,
      }),
    ).toBe(2_000_000);
  });

  test("塊が 1 つしか来なければ、取り始めてからで割る。何も来なければ null", () => {
    expect(
      probeRate({
        startAt: 0,
        firstAt: 50,
        firstBytes: 65_536,
        lastAt: 50,
        bytes: 65_536,
      }),
    ).toBeCloseTo((65_536 * 8 * 1000) / 50);
    expect(
      probeRate({
        startAt: 0,
        firstAt: null,
        firstBytes: 0,
        lastAt: 2_000,
        bytes: 0,
      }),
    ).toBeNull();
  });
});
