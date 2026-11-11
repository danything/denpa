import { describe, expect, test } from "bun:test";

import {
  messageTables,
  parseMessage,
  parseMmtp,
  parseMpu,
  SignalingAssembler,
} from "./mmtp.js";
import {
  m2SectionMessage,
  mmtpPacket,
  mpuPayload,
  paMessage,
  pltTable,
  signalingPackets,
} from "./synth-mmt.js";

/** 長さ `length` の M2 セクションメッセージ (中身は番号) */
function message(length: number, fill = 0): Uint8Array {
  const section = new Uint8Array(length).fill(fill);
  section[0] = 0x8c;
  return m2SectionMessage(section);
}

/** パケットを順に組み立てに通して、そろったメッセージを集める */
function assemble(packets: Uint8Array[], assembler = new SignalingAssembler()) {
  return packets.flatMap((bytes) => assembler.feed("cid:1", parseMmtp(bytes)!));
}

describe("parseMmtp", () => {
  test("ヘッダーとスクランブルの印を読む", () => {
    const packet = parseMmtp(
      mmtpPacket({
        packetId: 0xf100,
        payloadType: 0,
        sequenceNumber: 0x12345678,
        rap: true,
        scrambling: "odd",
        payload: mpuPayload([1, 2, 3], 9),
      }),
    )!;
    expect(packet.packetId).toBe(0xf100);
    expect(packet.sequenceNumber).toBe(0x12345678);
    expect(packet.rap).toBe(true);
    expect(packet.scrambling).toBe("odd");

    const mpu = parseMpu(packet.payload)!;
    expect(mpu.fragmentType).toBe(2);
    expect(mpu.timed).toBe(true);
    expect(mpu.mpuSequenceNumber).toBe(9);
    expect([...mpu.data]).toEqual([1, 2, 3]);
  });

  test("ヘッダー拡張が無ければ、スクランブルの印は null", () => {
    const packet = parseMmtp(
      mmtpPacket({ packetId: 0, payloadType: 2, payload: [0, 0] }),
    )!;
    expect(packet.scrambling).toBeNull();
    expect(packet.payload.length).toBe(2);
  });
});

describe("SignalingAssembler", () => {
  test("分割したメッセージを 3 つ以上のパケットから組み立てる", () => {
    const whole = message(1000, 5);
    const packets = signalingPackets(0x8000, [whole], { fragment: 300 });
    expect(packets.length).toBe(4);
    expect(assemble(packets)).toEqual([whole]);
  });

  test("途中が欠けたら、組み立て中のものを捨てて次の先頭から読む", () => {
    const first = signalingPackets(0x8000, [message(700, 1)], {
      fragment: 300,
    });
    const second = signalingPackets(0x8000, [message(500, 2)], {
      fragment: 300,
      sequenceNumber: 3,
    });
    const assembler = new SignalingAssembler();
    const out = assemble([first[0]!, first[2]!, ...second], assembler);
    expect(out).toEqual([message(500, 2)]);
    expect(assembler.dropped).toBe(1);
  });

  test("集約したメッセージを、16 ビットと 32 ビットの長さで切り分ける", () => {
    const messages = [message(10, 1), message(20, 2), message(30, 3)];
    for (const aggregate of ["short", "long"] as const) {
      const packets = signalingPackets(0, messages, { aggregate });
      expect(packets.length).toBe(1);
      expect(assemble(packets)).toEqual(messages);
    }
  });
});

describe("parseMessage", () => {
  test("PA メッセージ (長さ 32 ビット) から表を並べる", () => {
    const plt = pltTable([[0xa1, 0xff01]]);
    const tables = messageTables(parseMessage(paMessage(plt, plt))!);
    expect(tables).toEqual([plt, plt]);
  });

  test("M2 セクションメッセージ (長さ 16 ビット) はセクションを 1 つ運ぶ", () => {
    const parsed = parseMessage(message(40))!;
    expect(parsed.messageId).toBe(0x8000);
    expect(messageTables(parsed)[0]!.length).toBe(40);
  });

  test("長さが足りなければ null", () => {
    expect(parseMessage(message(40).subarray(0, 30))).toBeNull();
  });
});
