import { describe, expect, test } from "bun:test";

import { concatBytes } from "./bytes.js";
import {
  mmtDescriptors,
  MmtTableStream,
  parseMhSdt,
  parseMhTot,
  parseMpt,
  parsePlt,
  parseTlvNit,
  tlvSiSections,
} from "./mmt-si.js";
import {
  compressedIp,
  ipv6Udp,
  m2SectionMessage,
  mhSdtSection,
  mhTotSection,
  mmtDescriptor,
  mptTable,
  paMessage,
  pltTable,
  signalingPackets,
  tlvNitSection,
  tlvPacket,
  tlvSi,
} from "./synth-mmt.js";

/** 実機 (ケーブルで受けた BS4K) の TLV のストリームと局 */
const TLV_STREAM = 0xb111;
const ONID = 0x000b;
const SERVICE = 0xa1;

describe("mmtDescriptors", () => {
  test("タグが 0xF000 未満は長さ 1 バイト、以上は 2 バイト", () => {
    const long = new Array(300).fill(7);
    const data = Uint8Array.from([
      ...mmtDescriptor(0x8010, [1, 2]),
      ...mmtDescriptor(0xf001, long),
      ...mmtDescriptor(0x8012, [3]),
    ]);
    const out = [...mmtDescriptors(data)].map(([tag, body]) => [
      tag,
      body.length,
    ]);
    expect(out).toEqual([
      [0x8010, 2],
      [0xf001, 300],
      [0x8012, 1],
    ]);
  });

  test("長さが足りない記述子の手前で止まる", () => {
    const data = Uint8Array.from([
      ...mmtDescriptor(0x8010, [1]),
      0x80,
      0x12,
      5,
      1,
    ]);
    expect([...mmtDescriptors(data)].length).toBe(1);
  });
});

describe("PLT と MPT", () => {
  test("PLT が指す packet_id の MPT から、アセットと ECM を読む", () => {
    const plt = parsePlt(pltTable([[SERVICE, 0xff01]], 5))!;
    expect(plt.version).toBe(5);
    expect(plt.packages[0]!.packageId).toBe(SERVICE);
    expect(plt.packages[0]!.location.packetId).toBe(0xff01);

    const mpt = parseMpt(
      mptTable({
        packageId: SERVICE,
        access: { caSystemId: 0x0005, ecmPacketId: 0xfff1 },
        assets: [
          { type: "hev1", packetId: 0xf100, componentTag: 0x0000 },
          { type: "mp4a", packetId: 0xf110, componentTag: 0x0010 },
          { type: "stpp", packetId: 0xf130 },
        ],
      }),
    )!;
    expect(mpt.packageId).toBe(SERVICE);
    expect(mpt.access.map((a) => [a.caSystemId, a.location.packetId])).toEqual([
      [0x0005, 0xfff1],
    ]);
    expect(
      mpt.assets.map((a) => [a.type, a.locations[0]!.packetId, a.componentTag]),
    ).toEqual([
      ["hev1", 0xf100, 0x0000],
      ["mp4a", 0xf110, 0x0010],
      ["stpp", 0xf130, null],
    ]);
  });
});

describe("MH-SDT と TLV-NIT", () => {
  test("局名と事業者名を UTF-8 で読む", () => {
    const sdt = parseMhSdt(
      mhSdtSection(
        0xb070,
        ONID,
        [
          {
            serviceId: 0x97,
            name: "ＢＳでんぱ　４Ｋ",
            providerName: "ＢＳでんぱ",
          },
        ],
        true,
      ),
    )!;
    expect(sdt.other).toBe(true);
    expect(sdt.tlvStreamId).toBe(0xb070);
    expect(sdt.originalNetworkId).toBe(ONID);
    expect(sdt.services).toEqual([
      {
        serviceId: 0x97,
        serviceType: 0x01,
        name: "ＢＳでんぱ　４Ｋ",
        providerName: "ＢＳでんぱ",
        isFree: true,
        eitSchedule: true,
        eitPresentFollowing: true,
      },
    ]);
  });

  test("TLV-NIT のネットワーク名と、TLV のストリームごとの局を読む", () => {
    const nit = parseTlvNit(
      tlvNitSection(ONID, "高度ＢＳデジタル放送", [
        [0xb070, ONID, [[0x97, 1]]],
        [TLV_STREAM, ONID, [[SERVICE, 1]]],
      ]),
    )!;
    expect(nit.networkId).toBe(ONID);
    expect(nit.name).toBe("高度ＢＳデジタル放送");
    expect(nit.streams.map((s) => [s.tlvStreamId, s.services])).toEqual([
      [0xb070, [{ serviceId: 0x97, serviceType: 1 }]],
      [TLV_STREAM, [{ serviceId: SERVICE, serviceType: 1 }]],
    ]);
  });

  test("TLV-SI から、CRC の合うセクションだけを切り出す", () => {
    const nit = tlvNitSection(ONID, "x", []);
    const broken = nit.slice();
    broken[10] = broken[10]! ^ 0xff;
    expect(
      tlvSiSections(concatBytes([nit, broken, Uint8Array.of(0xff, 0xff)])),
    ).toEqual([nit]);
  });

  test("MH-TOT の時刻を読む", () => {
    const at = Date.UTC(2026, 10, 11, 3, 4, 5);
    expect(parseMhTot(mhTotSection(at))).toBe(at);
  });
});

describe("MmtTableStream", () => {
  test("TLV のバイト列から、TLV-SI と信号メッセージの表を取り出す", () => {
    const plt = pltTable([[SERVICE, 0xff01]]);
    const mpt = mptTable({ packageId: SERVICE, assets: [] });
    const sdt = mhSdtSection(TLV_STREAM, ONID, [
      { serviceId: SERVICE, name: "局" },
    ]);
    const nit = tlvNitSection(ONID, "高度ＢＳデジタル放送", []);
    const broken = sdt.slice();
    broken[12] = broken[12]! ^ 0xff;
    const tot = mhTotSection(Date.UTC(2026, 10, 11));
    tot[1] = tot[1]! & 0x7f;
    const ip = (bytes: Uint8Array) => compressedIp(1, bytes);
    const data = concatBytes([
      tlvSi(nit),
      ...signalingPackets(0x0000, [paMessage(plt)]).map(ip),
      ...signalingPackets(0xff01, [paMessage(mpt)]).map(ip),
      // 番組表のように長いものは分割して来る
      ...signalingPackets(0x8004, [m2SectionMessage(sdt)], {
        fragment: 20,
      }).map(ip),
      // CRC の合わないセクションは落とす
      ...signalingPackets(0x8004, [m2SectionMessage(broken)], {
        sequenceNumber: 9,
      }).map(ip),
      // section_syntax_indicator が 0 の表 (MH-TOT) も、CRC が合わなければ落とす
      ...signalingPackets(0x8003, [m2SectionMessage(tot)]).map(ip),
      // 圧縮していない IP (NTP) は、中身が MMTP に見えても読まない
      ipv6Udp(
        "ff02::101",
        123,
        signalingPackets(0x0000, [paMessage(plt)], { sequenceNumber: 5 })[0]!,
      ),
      tlvPacket(0xff, [0, 0]),
    ]);
    const out = [...new MmtTableStream().feed(data)].map((t) => [
      t.flow,
      t.packetId,
      t.table[0],
    ]);
    expect(out).toEqual([
      [null, null, 0x40],
      ["cid:1", 0x0000, 0x80],
      ["cid:1", 0xff01, 0x20],
      ["cid:1", 0x8004, 0x9f],
    ]);
  });
});
