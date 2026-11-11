import { describe, expect, test } from "bun:test";

import { concatBytes } from "@danything/arib/bytes";
import {
  eitSection,
  packetize,
  stream,
  type SynthEvent,
} from "@danything/arib/synth";
import {
  compressedIp,
  m2SectionMessage,
  mhEitSection,
  signalingPackets,
  tlvPacket,
} from "@danything/arib/synth-mmt";

import { PfEvent } from "./pf-event";

/**
 * 録り始めに、録る番組の EIT[p/f] を読むところ (`recorder.ts` の `refreshFromPf`)。
 * 番組表 (schedule) は数日前の内容で、局によっては話数を放送の直前の p/f にしか載せない
 */
const SERVICE = 23608;
const OTHER = 23609;
const START = Date.UTC(2026, 10, 10, 15, 30);
const MINUTE = 60_000;

const before: SynthEvent = {
  eventId: 100,
  startAt: START - 30 * MINUTE,
  duration: 30 * MINUTE,
  name: "前の番組",
  runningStatus: 4,
};
const target: SynthEvent = {
  eventId: 101,
  startAt: START,
  duration: 30 * MINUTE,
  name: "アニメ　凶乱令嬢ニア・リストン",
  description: "第6話　副題",
  runningStatus: 1,
};

/** p/f の 1 節 (section 0 = いま、1 = 次) を TS パケットに */
function pf(
  sectionNumber: number,
  event: SynthEvent,
  serviceId = SERVICE,
  tableId = 0x4e,
): Uint8Array {
  return packetize(
    0x0012,
    eitSection({
      tableId,
      serviceId,
      transportStreamId: 1,
      originalNetworkId: 4,
      sectionNumber,
      lastSectionNumber: 1,
      events: [event],
    }),
  );
}

describe("録る番組の EIT[p/f] を読む", () => {
  test("開始マージンのうちは「次」に載る。event_id が合えば、概要ごと返す", () => {
    const watch = new PfEvent(
      SERVICE,
      target.eventId,
      "ts",
      15_000,
      () => START,
    );
    const seen = watch.feed(stream(pf(0, before), pf(1, target)));
    expect(seen).not.toBeNull();
    expect(seen).not.toBe("timeout");
    if (seen === null || seen === "timeout") return;
    expect(seen.eventId).toBe(101);
    expect(seen.description).toBe("第6話　副題");
  });

  test("始まったあとなら「いま」に載る", () => {
    const watch = new PfEvent(
      SERVICE,
      target.eventId,
      "ts",
      15_000,
      () => START,
    );
    const seen = watch.feed(pf(0, { ...target, runningStatus: 4 }));
    expect(seen).toMatchObject({ eventId: 101 });
  });

  test("ほかの局の p/f と番組表 (schedule) は見ない", () => {
    const watch = new PfEvent(
      SERVICE,
      target.eventId,
      "ts",
      15_000,
      () => START,
    );
    expect(watch.feed(pf(1, target, OTHER))).toBeNull();
    expect(watch.feed(pf(0, target, SERVICE, 0x50))).toBeNull();
  });

  test("パケットの途中で塊が切れても読める", () => {
    const watch = new PfEvent(
      SERVICE,
      target.eventId,
      "ts",
      15_000,
      () => START,
    );
    const bytes = stream(pf(0, before), pf(1, target));
    expect(watch.feed(bytes.subarray(0, 100))).toBeNull();
    expect(watch.feed(bytes.subarray(100))).toMatchObject({ eventId: 101 });
  });

  test("最初の塊から上限を過ぎても届かなければ打ち切る (選局に掛かった時間は数えない)", () => {
    let clock = START;
    const watch = new PfEvent(
      SERVICE,
      target.eventId,
      "ts",
      15_000,
      () => clock,
    );
    clock += 60_000;
    // 最初の塊が届いた時刻から数える
    expect(watch.feed(pf(0, before))).toBeNull();
    clock += 14_999;
    expect(watch.feed(pf(0, before))).toBeNull();
    clock += 1;
    expect(watch.feed(pf(0, before))).toBe("timeout");
  });
  test("4K の局 (TLV) は MH-EIT[p/f] から読む", () => {
    const section = (
      sectionNumber: number,
      event: SynthEvent,
      tableId = 0x8b,
    ) =>
      mhEitSection({
        tableId,
        serviceId: SERVICE,
        tlvStreamId: 0xb111,
        originalNetworkId: 0x000b,
        sectionNumber,
        events: [
          {
            eventId: event.eventId,
            startAt: event.startAt,
            duration: event.duration,
            name: event.name,
            description: event.description ?? "",
          },
        ],
      });
    const tlv = (...sections: Uint8Array[]) =>
      concatBytes([
        ...signalingPackets(
          0x8000,
          sections.map((s) => m2SectionMessage(s)),
        ).map((p) => compressedIp(1, p)),
        tlvPacket(0xff, [0]),
      ]);
    const watch = new PfEvent(
      SERVICE,
      target.eventId,
      "tlv",
      15_000,
      () => START,
    );
    // 予定の表 (0x8C) は見ない
    expect(watch.feed(tlv(section(0, target, 0x8c)))).toBeNull();
    expect(
      watch.feed(tlv(section(0, before), section(1, target))),
    ).toMatchObject({ eventId: 101, description: "第6話　副題" });
  });
});
