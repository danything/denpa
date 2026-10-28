import { describe, expect, test } from "bun:test";

import {
  BML_TS,
  bmlHead,
  pcrPacket,
  stream,
  tdtPacket as tdt,
} from "@danything/arib/synth";

import { DataBroadcastCapture } from "./data-capture";
import { TsHead } from "./ts-head";

/*
 * 録画の頭の放送時刻。録っている間 (`recorder.ts`) とエンコードのとき (`data-capture.ts`) で
 * 同じ部品を使うので、**どちらで測っても同じ値になる**ことを見る
 */

const { videoPid } = BML_TS;
const T1 = Date.UTC(2026, 9, 28, 12, 0, 0);

/** 頭の PCR は 1000秒。12秒進んだところで初めて TDT (T1) が来る */
const recorded = () =>
  stream(
    pcrPacket(videoPid, 1000),
    ...bmlHead(),
    pcrPacket(videoPid, 1006),
    pcrPacket(videoPid, 1012),
    tdt(T1),
    pcrPacket(videoPid, 1017),
    tdt(T1 + 5_000),
  );

describe("TsHead", () => {
  test("最初の TDT から、そこまでに PCR が進んだぶんを引く", () => {
    const head = new TsHead();
    head.feed(recorded());
    expect(head.head).toBe(T1 - 12_000);
  });

  test("データ放送の取り出しと同じ値になる", () => {
    const head = new TsHead();
    const capture = new DataBroadcastCapture();
    head.feed(recorded());
    capture.feed(recorded());
    expect(head.head).toBe(capture.head);
  });

  test("細かく分けて食わせても同じ", () => {
    const whole = recorded();
    const head = new TsHead();
    for (let at = 0; at < whole.length; at += 100)
      head.feed(whole.subarray(at, at + 100));
    expect(head.head).toBe(T1 - 12_000);
  });

  test("TDT が来なければ null", () => {
    const head = new TsHead();
    head.feed(stream(pcrPacket(videoPid, 1000), ...bmlHead()));
    expect(head.head).toBeNull();
  });
});
