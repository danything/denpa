import { describe, expect, test } from "bun:test";

import { type Network, NitReader } from "@danything/arib/psi";
import {
  cableDeliveryDescriptor,
  nitSection,
  packetize,
  satelliteDeliveryDescriptor,
} from "@danything/arib/synth";

import {
  cableChannelOf,
  cableLineupFrom,
  catvChannels,
  describeLineup,
  entranceOrder,
  lineupChanges,
  lineupJobs,
  parseStored,
  RAW_LIMIT,
  toStored,
} from "./cable";
import type { AgentChannel } from "./tuner";

/** 合成の NIT を読んで、そろった NIT[actual] を返す */
function network(section: Uint8Array): Network {
  const reader = new NitReader();
  reader.feed(packetize(0x0010, section));
  return reader.actual!;
}

/**
 * 合成のケーブル局の NIT。値は本番の J:COM の回線で見えたものに寄せる (自主放送のネットワーク ID 0xFFFE。2026-11-11 の録り)。
 * QC26 は TSMF で TS を 2 つ束ねた 256QAM、QC39 と QU32 は TS が 1 つの 64QAM
 */
const jcomNit = (
  extra: [number, number, [number, number][], number[]?][] = [],
) =>
  nitSection(
    0xfffe,
    null,
    [
      [
        0x0016,
        0xfffe,
        [
          [0x01c4, 0x01],
          [0x02f1, 0x01],
        ],
        cableDeliveryDescriptor(321_000_000),
      ],
      [
        0x0021,
        0xfffe,
        [[0x028a, 0x01]],
        cableDeliveryDescriptor(243_000_000, { frameType: 1, modulation: 5 }),
      ],
      [
        0x0022,
        0xfffe,
        [[0x028b, 0x01]],
        cableDeliveryDescriptor(243_000_000, { frameType: 1, modulation: 5 }),
      ],
      [0x0002, 0xfffe, [[0x0300, 0x01]], cableDeliveryDescriptor(599_000_000)],
      ...extra,
    ],
    { name: "ケーブル", version: 3 },
  );

describe("周波数とチャンネルの名前", () => {
  test("格子に乗る周波数は今の名前 (QC・QU・QV)", () => {
    expect(cableChannelOf(111_000_000)).toBe("QC13");
    expect(cableChannelOf(159_000_000)).toBe("QC21");
    expect(cableChannelOf(167_000_000)).toBe("QC22");
    expect(cableChannelOf(225_000_000)).toBe("QC23");
    expect(cableChannelOf(465_000_000)).toBe("QC63");
    expect(cableChannelOf(473_000_000)).toBe("QU13");
    expect(cableChannelOf(767_000_000)).toBe("QU62");
    expect(cableChannelOf(93_000_000)).toBe("QV1");
    expect(cableChannelOf(173_000_000)).toBe("QV4");
    // iTSCOM の高度ケーブル自主放送の NIT に載っていた周波数
    expect(cableChannelOf(99_000_000)).toBe("QV2");
    expect(cableChannelOf(201_000_000)).toBe("QV9");
    expect(cableChannelOf(219_000_000)).toBe("QV12");
    expect(cableChannelOf(515_000_000)).toBe("QU20");
  });

  test("100 Hz 単位のずれは丸め、QC24〜QC27 を 2 MHz ずらしたものもその名前", () => {
    expect(cableChannelOf(243_000_100)).toBe("QC26");
    expect(cableChannelOf(242_600_000)).toBe("QC26");
    expect(cableChannelOf(233_000_000)).toBe("QC24");
    expect(cableChannelOf(251_000_000)).toBe("QC27");
  });

  test("格子に乗らない周波数は周波数を直に指し、範囲の外は null", () => {
    expect(cableChannelOf(246_500_000)).toBe("QF246500");
    expect(cableChannelOf(170_000_000)).toBe("QF170000");
    expect(cableChannelOf(80_000_000)).toBeNull();
    expect(cableChannelOf(800_000_000)).toBeNull();
  });

  test("総当たりは QC → QU → QV の 113 本で、名前は重ならない", () => {
    const channels = catvChannels();
    expect(channels).toHaveLength(113);
    expect(channels.slice(0, 2)).toEqual(["QC13", "QC14"]);
    expect(channels.slice(-2)).toEqual(["QV11", "QV12"]);
    expect(new Set(channels).size).toBe(113);
  });
});

describe("ケーブル局の NIT から一覧を作る", () => {
  test("周波数ごとにまとめ、TSMF で束ねた搬送波は 2 つ目からの TS に番号を付ける", () => {
    const lineup = cableLineupFrom(network(jcomNit()))!;
    expect(lineup.networkId).toBe(0xfffe);
    expect(lineup.name).toBe("ケーブル");
    expect(lineup.version).toBe(3);
    expect(lineup.others).toBe(false);
    expect(
      lineup.carriers.map((carrier) => [
        carrier.channel,
        carrier.modulation,
        carrier.streams.map((ts) => ts.transportStreamId),
      ]),
    ).toEqual([
      ["QC26", 5, [0x0021, 0x0022]],
      ["QC39", 3, [0x0016]],
      ["QU34", 3, [0x0002]],
    ]);
    expect(lineupJobs(lineup)).toEqual(["QC26", "QC26:1", "QC39", "QU34"]);
  });

  test("再送信の TS (ほかの ONID) も載っていれば others", () => {
    const lineup = cableLineupFrom(
      network(
        jcomNit([
          [0x40f1, 4, [[0x0097, 0x01]], cableDeliveryDescriptor(273_000_000)],
        ]),
      ),
    )!;
    expect(lineup.others).toBe(true);
    expect(lineupJobs(lineup)).toContain("QC31");
  });

  test("0x44 の無い NIT (再送信の BS・地上波) からは作らない", () => {
    expect(
      cableLineupFrom(
        network(
          nitSection(4, null, [
            [16400, 4, [[151, 0x01]], satelliteDeliveryDescriptor(11_727_480)],
          ]),
        ),
      ),
    ).toBeNull();
    expect(
      cableLineupFrom(
        network(nitSection(0x7fe0, 6, [[0x7fe0, 0x7fe0, [[1024, 0x01]]]])),
      ),
    ).toBeNull();
  });

  test("推定に合わない値の TS は入れずに理由を返し、1 つも入らなければ作らない", () => {
    const odd = network(
      nitSection(0xfffe, null, [
        [1, 0xfffe, [[1, 0x01]], cableDeliveryDescriptor(1_200_000_000)],
        [
          2,
          0xfffe,
          [[2, 0x01]],
          cableDeliveryDescriptor(321_000_000, { modulation: 0x08 }),
        ],
      ]),
    );
    expect(cableLineupFrom(odd)).toBeNull();
    const mixed = cableLineupFrom(
      network(
        jcomNit([
          [
            3,
            0xfffe,
            [[3, 0x01]],
            cableDeliveryDescriptor(321_000_000, { modulation: 0x08 }),
          ],
        ]),
      ),
    )!;
    expect(mixed.skipped).toEqual([
      { transportStreamId: 3, why: "変調 0x08 は ISDB-C の変調ではありません" },
    ]);
  });

  test("記録に NIT の中身とバイト列を出す (バイト列は上限まで)", () => {
    const lineup = cableLineupFrom(network(jcomNit()))!;
    const lines = describeLineup(lineup, "QC39");
    expect(lines[0]).toBe(
      "QC39: ケーブルのネットワーク 0xFFFE「ケーブル」の NIT (version 3) を読みました。搬送波 3・TS 4",
    );
    expect(lines[1]).toBe(
      "  QC26  243.0000 MHz  256QAM  5.2740 Msps  RS(204,188)  TSMF  TS 0x0021 (ONID 0xFFFE、1 局)・TS 0x0022 (ONID 0xFFFE、1 局)",
    );
    expect(
      lines.some((line) => line.includes("自分のネットワークの TS だけです")),
    ).toBe(true);
    const raw = lines.filter((line) => line.includes("NIT のセクション 0"));
    expect(raw[0]).toContain(": 40B0");
    const big = {
      ...lineup,
      sections: [new Uint8Array(1000), new Uint8Array(1000)],
    };
    const shown = describeLineup(big, "QC39")
      .filter((line) => line.includes("NIT のセクション"))
      .reduce((sum, line) => sum + line.split(": ")[1]!.length / 2, 0);
    expect(shown).toBe(RAW_LIMIT);
  });
});

describe("控え", () => {
  const channel = (name: string, networkId: number): AgentChannel => ({
    type: "CATV",
    channel: name,
    networkId,
    transportStreamId: 1,
    remoteControlKeyId: null,
    services: [],
  });

  test("入口は控えの入口 → 前の控えの自主放送らしいチャンネル → 総当たりの順。数は変えない", () => {
    const channels = catvChannels();
    const stored = toStored("QC39", [cableLineupFrom(network(jcomNit()))!]);
    const order = entranceOrder(channels, stored, [
      channel("QC20", 4),
      channel("QC31", 0x7e77),
      channel("QC28", 0xfffe),
      channel("QC30:1", 0xfffe),
      channel("QC39", 0xfffe),
    ]);
    expect(order.slice(0, 3)).toEqual(["QC39", "QC28", "QC13"]);
    expect(order).toHaveLength(113);
    expect(new Set(order).size).toBe(113);
    expect(entranceOrder(channels, null, [])).toEqual(channels);
    // 入口が TSMF の 2 つ目からの TS なら、その搬送波を先に開く
    expect(
      entranceOrder(channels, { ...stored, entrance: "QC30:1" }, [])[0],
    ).toBe("QC30");
  });

  test("書いて読み直せ、壊れた控えは null", () => {
    const stored = toStored("QC39", [cableLineupFrom(network(jcomNit()))!]);
    expect(parseStored(JSON.stringify(stored))).toEqual(stored);
    expect(stored.networks[0]?.carriers.map((c) => c.channel)).toEqual([
      "QC26",
      "QC39",
      "QU34",
    ]);
    expect(parseStored(undefined)).toBeNull();
    expect(parseStored("")).toBeNull();
    expect(parseStored("{")).toBeNull();
    expect(parseStored("{}")).toBeNull();
  });

  test("前の控えと比べて、増えた搬送波と無くなった搬送波を出す", () => {
    const before = toStored("QC39", [cableLineupFrom(network(jcomNit()))!]);
    const after = toStored("QC39", [
      cableLineupFrom(
        network(
          jcomNit([
            [0x0003, 0xfffe, [[1, 0x01]], cableDeliveryDescriptor(279_000_000)],
          ]),
        ),
      )!,
    ]);
    after.networks[0]!.carriers = after.networks[0]!.carriers.filter(
      (carrier) => carrier.channel !== "QU34",
    );
    expect(lineupChanges(before, after)).toEqual([
      "CATV: 前のスキャンから搬送波が増えました: QC32",
      "CATV: 前のスキャンから搬送波が無くなりました: QU34",
    ]);
    expect(lineupChanges(null, after)).toEqual([]);
  });
});
