import { describe, expect, test } from "bun:test";

import {
  BML_TS,
  bmlHead,
  nptReferenceDescriptor,
  packetize,
  pcrPacket,
  stream,
  streamDescriptorSection,
  tdtPacket as tdt,
} from "@danything/arib/synth";

import { stcUnixMs } from "./clock";
import { DataBroadcastCapture } from "./data-capture";
import { TsHead } from "./ts-head";

/*
 * 録画の先頭の放送時刻。録っている間 (`recorder.ts`) とエンコードのとき (`data-capture.ts`) で
 * 同じ部品を使うので、**どちらで測っても同じ値になる**ことを見る
 */

const { videoPid } = BML_TS;
const T1 = Date.UTC(2026, 9, 28, 12, 0, 0);

/** 先頭の PCR は 1000 秒。12 秒進んだところで初めて TDT (T1) が来る */
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

  test("細かく分けて渡しても同じ", () => {
    const whole = recorded();
    const head = new TsHead();
    for (let at = 0; at < whole.length; at += 100)
      head.feed(whole.subarray(at, at + 100));
    expect(head.head).toBe(T1 - 12_000);
  });

  test("先頭の PCR と放送時刻の組 (`anchor`) から、PCR の時計の値を放送時刻に直せる", () => {
    const head = new TsHead();
    head.feed(recorded());
    const anchor = head.anchor!;
    expect(anchor).toEqual({ pcr: 1000, unixMs: T1 - 12_000 });
    expect(stcUnixMs(anchor, 1017 * 90_000)).toBe(T1 + 5_000);
    // 先頭より前の STC も、近いほう (前) で数える
    expect(stcUnixMs(anchor, 990 * 90_000)).toBe(T1 - 22_000);
  });

  test("録画のデータ放送の NPT 参照に、先頭から PCR が進んだぶんの時刻を付ける", () => {
    const capture = new DataBroadcastCapture();
    capture.feed(
      stream(
        recorded(),
        // STC 1010 秒で NPT 0 の参照。1017 秒の PCR のあとに届く
        packetize(
          BML_TS.bmlPid,
          streamDescriptorSection([nptReferenceDescriptor(1010 * 90_000, 0)]),
        ),
      ),
    );
    const npt = capture
      .result()
      .map((item) => item.message)
      .find((message) => message.type === "nptUpdated");
    expect(npt).toMatchObject({
      stc: 1010 * 90_000,
      timeUnixMillis: T1 - 2_000,
    });
  });

  test("TDT が来なければ null", () => {
    const head = new TsHead();
    head.feed(stream(pcrPacket(videoPid, 1000), ...bmlHead()));
    expect(head.head).toBeNull();
  });
});
