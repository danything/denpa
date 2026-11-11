import { describe, expect, test } from "bun:test";

import { concatBytes } from "./bytes.js";
import { MmtEpgReader, parseMhEit } from "./mh-eit.js";
import {
  compressedIp,
  m2SectionMessage,
  mhEitSection,
  signalingPackets,
  type SynthMhEit,
  type SynthMhEvent,
  tlvPacket,
} from "./synth-mmt.js";

const TLV_STREAM = 0xb111;
const ONID = 0x000b;
const SERVICE = 0xa1;
/** 2026-11-11 19:30 JST */
const START = Date.UTC(2026, 10, 11, 10, 30);
/** 2026-11-11 00:10 JST。まだどの枠も過ぎていない */
const DAY_START = Date.UTC(2026, 10, 10, 15, 10);

function event(overrides: Partial<SynthMhEvent> = {}): SynthMhEvent {
  return {
    eventId: 1,
    startAt: START,
    duration: 60 * 60_000,
    name: "🈑報道１９３０",
    description: "きょうのニュース",
    ...overrides,
  };
}

function section(overrides: Partial<SynthMhEit> = {}): Uint8Array {
  return mhEitSection({
    tableId: 0x8c,
    serviceId: SERVICE,
    tlvStreamId: TLV_STREAM,
    originalNetworkId: ONID,
    events: [event()],
    ...overrides,
  });
}

/**
 * セクションを、実機と同じく M2 セクションメッセージで、長ければ分割して TLV に載せる。
 * 末尾に詰め物を 1 つ足す (`TlvStream` は、次のパケットの先頭が届くまで最初のパケットを出さない)
 */
function tlv(...sections: Uint8Array[]): Uint8Array {
  let sequenceNumber = 0;
  return concatBytes([
    ...sections.flatMap((s) => {
      const packets = signalingPackets(0x8000, [m2SectionMessage(s)], {
        fragment: 200,
        sequenceNumber,
      });
      sequenceNumber += packets.length;
      return packets.map((p) => compressedIp(1, p));
    }),
    tlvPacket(0xff, [0]),
  ]);
}

describe("parseMhEit", () => {
  test("番組名と説明を UTF-8 で読み、table_id を TS の番号に直す", () => {
    const parsed = parseMhEit(
      section({
        events: [event({ genres: [[0, 1]], resolution: 6, copyControl: 2 })],
      }),
    )!;
    expect(parsed.tableId).toBe(0x50);
    expect(parsed.lastTableId).toBe(0x50);
    expect(parsed.transportStreamId).toBe(TLV_STREAM);
    const [read] = parsed.events;
    expect(read).toMatchObject({
      serviceId: SERVICE,
      originalNetworkId: ONID,
      startAt: START,
      duration: 60 * 60_000,
      name: "🈑報道１９３０",
      description: "きょうのニュース",
      genres: [{ lv1: 0, lv2: 1 }],
      video: { type: null, resolution: "2160p" },
      copyNever: false,
      isFree: true,
    });
    expect(read!.series).toBeUndefined();
  });

  test("コピー禁止を読む", () => {
    const parsed = parseMhEit(
      section({ events: [event({ copyControl: 3 })] }),
    )!;
    expect(parsed.events[0]!.copyNever).toBe(true);
  });

  test("詳細の表 (0x94〜) は TS の 0x58〜 になり、コピー制御を言っていない", () => {
    const parsed = parseMhEit(
      section({ tableId: 0x94, events: [event({ name: "" })] }),
    )!;
    expect(parsed.tableId).toBe(0x58);
    expect(parsed.events[0]!.copyNever).toBeNull();
  });

  test("拡張形式イベントは、UTF-8 の文字の途中で区切れていても繋ぎ直す", () => {
    const parsed = parseMhEit(
      section({
        events: [
          event({
            // 3 バイトの字を 4 バイトずつ区切るので、字の途中で切れる
            extended: [
              ["番組内容", "通販各社のＴＶショッピング"],
              ["出演者", "でんぱ太郎"],
            ],
            split: 4,
          }),
        ],
      }),
    )!;
    expect(parsed.events[0]!.extended).toEqual({
      番組内容: "通販各社のＴＶショッピング",
      出演者: "でんぱ太郎",
    });
  });

  test("MH-EIT でなければ null", () => {
    expect(parseMhEit(section({ tableId: 0x9f }))).toBeNull();
  });
});

describe("MmtEpgReader", () => {
  test("TLV のバイト列から番組を溜め、基本と詳細を混ぜる", () => {
    const reader = new MmtEpgReader(() => DAY_START);
    const basic = section({ tableId: 0x8c, lastTableId: 0x94 });
    const extended = section({
      tableId: 0x94,
      lastTableId: 0x94,
      events: [
        event({
          name: "",
          description: "",
          extended: [["番組内容", "詳しい説明"]],
        }),
      ],
    });
    expect(reader.feed(tlv(basic, extended))).toBe(true);
    const [read] = reader.all();
    expect(read!.name).toBe("🈑報道１９３０");
    expect(read!.extended).toEqual({ 番組内容: "詳しい説明" });
    expect(reader.services()).toEqual([SERVICE]);
    // 基本 (0x8C) と詳細 (0x94) が 1 セクションずつで揃う
    expect(reader.complete).toBe(true);
  });

  test("p/f (0x8B) のいまを追う", () => {
    const reader = new MmtEpgReader(() => DAY_START);
    reader.feed(tlv(section({ tableId: 0x8b, runningStatus: 4 })));
    expect(reader.present.get(SERVICE)?.name).toBe("🈑報道１９３０");
  });

  test("チャンクの切れ目がどこに来ても読む", () => {
    const data = tlv(
      section({
        events: [event(), event({ eventId: 2, startAt: START + 3600_000 })],
      }),
    );
    const reader = new MmtEpgReader(() => DAY_START);
    for (let at = 0; at < data.length; at += 13)
      reader.feed(data.subarray(at, at + 13));
    expect(reader.all().map((e) => e.eventId)).toEqual([1, 2]);
  });
});
