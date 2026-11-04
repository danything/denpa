import { describe, expect, test } from "bun:test";

import { stepOrder } from "./adapt";
import type { Notice } from "./live";
import {
  RATE_LEAST,
  RATE_WINDOW,
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
