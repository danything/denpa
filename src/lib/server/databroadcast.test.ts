import { describe, expect, test } from "bun:test";

import { PACKET } from "@danything/arib/psi";
import {
  BML_TS,
  bxmlDescriptor,
  packetize,
  patSection,
  programMap,
} from "@danything/arib/synth";

import { AutoStartWatch } from "./databroadcast";

/** 入口の部品 (0x40) のデータ放送を載せた PMT。`autoStart` が自動起動の指定。`null` はデータ放送の無い PMT */
function pmt(autoStart: boolean | null): Uint8Array {
  return programMap(BML_TS.service, BML_TS.videoPid, [
    [0x02, BML_TS.videoPid, [0x52, 0x01, 0x00]],
    ...(autoStart === null
      ? []
      : ([
          [
            0x0d,
            BML_TS.bmlPid,
            [0x52, 0x01, 0x40, ...bxmlDescriptor({ autoStart })],
          ],
        ] as [number, number, number[]][])),
  ]);
}

/** PAT と PMT を TS にして 1 パケットずつ渡し、決めた値が決まったか変わったと答えた回数を返す */
function feed(watch: AutoStartWatch, ...sections: Uint8Array[]): number {
  let changed = 0;
  const ts = [
    packetize(0x0000, patSection([[BML_TS.service, BML_TS.pmtPid]])),
    ...sections.map((section) => packetize(BML_TS.pmtPid, section)),
  ];
  for (const chunk of ts)
    for (let at = 0; at < chunk.length; at += PACKET)
      if (watch.feedPacket(chunk.subarray(at, at + PACKET))) changed++;
  return changed;
}

describe("入口の部品に自動起動の指定があるか (PMT だけ読む)", () => {
  test("PMT を読むまでは分からない", () => {
    expect(new AutoStartWatch(BML_TS.service).value).toBeNull();
  });

  test("指定のある PMT を読んだら true。同じ PMT が繰り返し来ても、知らせるのは決まったときの 1 回", () => {
    const watch = new AutoStartWatch(BML_TS.service);
    expect(feed(watch, pmt(true), pmt(true), pmt(true))).toBe(1);
    expect(watch.value).toBe(true);
  });

  test("指定の無い入口と、データ放送の無い局は false (それも決まったときに知らせる)", () => {
    const flagless = new AutoStartWatch(BML_TS.service);
    expect(feed(flagless, pmt(false))).toBe(1);
    expect(flagless.value).toBe(false);
    const none = new AutoStartWatch(BML_TS.service);
    expect(feed(none, pmt(null))).toBe(1);
    expect(none.value).toBe(false);
  });

  test("番組が替わって指定が付いたり外れたりしたら、そのたびに知らせる", () => {
    const watch = new AutoStartWatch(BML_TS.service);
    expect(feed(watch, pmt(false), pmt(true), pmt(true), pmt(false))).toBe(3);
    expect(watch.value).toBe(false);
  });

  test("ほかの局の PMT は読まない", () => {
    const watch = new AutoStartWatch(BML_TS.service + 1);
    expect(feed(watch, pmt(true))).toBe(0);
    expect(watch.value).toBeNull();
  });
});
