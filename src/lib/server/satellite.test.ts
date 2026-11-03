import { describe, expect, test } from "bun:test";

import { NitReader, SdtReader } from "@danything/arib/psi";
import {
  nitSection,
  packetize,
  satelliteDeliveryDescriptor,
  sdtSection,
} from "@danything/arib/synth";

import {
  channelName,
  isLineupName,
  knownNames,
  lineupFrom,
  readLineup,
  readTables,
  transponderOf,
} from "./satellite";
import { leftoverNetworks, needsLineup } from "./satellite-lineup";
import type { AgentChannel } from "./tuner";

/**
 * 合成の放送で試す。値は本番の割当に合わせる (本番で 2026-11-03 に確かめた)。
 * BS はネットワーク 4 で、BS-1 に BS朝日1 (16400)、BS-15 に NHK BS (16625) と BS10 (18675)。
 * CS はネットワーク 6 (CS-2) と 7 (CS-4) で、NIT[other] にもう片方の TS と周波数が載る (サービスの一覧は無い)
 */

const BS1 = 11_727_480;
const BS15 = 11_996_000;
const CS2 = 12_291_000;
const CS4 = 12_331_000;

/** BS の NIT。ネットワーク 4 の全部の TS */
const bsNit = (version = 0) =>
  nitSection(
    4,
    null,
    [
      [16400, 4, [[151, 0x01]], satelliteDeliveryDescriptor(BS1)],
      [
        16625,
        4,
        [
          [101, 0x01],
          [929, 0xa4],
        ],
        satelliteDeliveryDescriptor(BS15),
      ],
      [18675, 4, [[200, 0x01]], satelliteDeliveryDescriptor(BS15)],
    ],
    { version },
  );

/** BS の SDT。開いた TS (16625) が actual、ほかは other */
const bsSdt = () => [
  sdtSection(16625, 4, [[101, 0x01, "NHK BS"]]),
  sdtSection(16400, 4, [[151, 0x01, "BS朝日1"]], { other: true }),
  sdtSection(18675, 4, [[200, 0x01, "BS10"]], { other: true }),
];

/** 合成の TS を、選局の代わりに返すストリームにする。`keepOpen` なら閉じない (放送は続く) */
function fromSections(
  parts: [number, Uint8Array][],
  keepOpen = false,
): ReadableStream<Uint8Array> {
  const data = Uint8Array.from(
    parts.flatMap(([pid, section], i) => [
      ...packetize(pid, section, i & 0x0f),
    ]),
  );
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      if (!keepOpen) controller.close();
    },
  });
}

const bsStream = (keepOpen = false) =>
  fromSections(
    [[0x10, bsNit()], ...bsSdt().map((s) => [0x11, s] as [number, Uint8Array])],
    keepOpen,
  );

describe("中継器の周波数と名前", () => {
  test("周波数から中継器の番号を出す (BS は奇数・CS は偶数)", () => {
    expect(transponderOf("BS", BS1)).toBe(1);
    expect(transponderOf("BS", BS15)).toBe(15);
    expect(transponderOf("BS", 11_727_480 + 38_360 * 11)).toBe(23);
    expect(transponderOf("CS", CS2)).toBe(2);
    expect(transponderOf("CS", CS4)).toBe(4);
    expect(transponderOf("CS", 12_291_000 + 40_000 * 11)).toBe(24);
  });

  test("その種別の中継器でない周波数は読まない", () => {
    // BS の周波数を CS として、CS の周波数を BS として読まない
    expect(transponderOf("CS", BS15)).toBeNull();
    expect(transponderOf("BS", CS2)).toBeNull();
    // 刻みから外れたもの・範囲の外
    expect(transponderOf("BS", BS1 + 5_000)).toBeNull();
    expect(transponderOf("BS", BS1 - 38_360)).toBeNull();
    expect(transponderOf("BS", 11_727_480 + 38_360 * 12)).toBeNull();
  });

  test("BS-7 と BS-17 (4K/8K) は読まない", () => {
    expect(transponderOf("BS", 11_727_480 + 38_360 * 3)).toBeNull();
    expect(transponderOf("BS", 11_727_480 + 38_360 * 8)).toBeNull();
  });

  test("名前は中継器と TSID。入口は中継器だけ", () => {
    expect(channelName("BS", 15, 16625)).toBe("BS15:16625");
    expect(channelName("BS", 1, 16400)).toBe("BS01:16400");
    expect(channelName("CS", 2)).toBe("CS02");
  });

  test("前のバージョンの名前を見分ける", () => {
    expect(isLineupName("BS15:16625")).toBe(true);
    expect(isLineupName("CS04:28736")).toBe(true);
    // 相対の番号と TSID の無い CS は前のバージョンの名前。エージェントが選局できない
    expect(isLineupName("BS15_0")).toBe(false);
    expect(isLineupName("CS02")).toBe(false);
    expect(isLineupName("T27")).toBe(false);
  });
});

describe("NIT と SDT から一覧を作る", () => {
  function read(parts: Uint8Array[], sdt: Uint8Array[] = []) {
    const nit = new NitReader();
    for (const section of parts) nit.feed(packetize(0x10, section));
    const tables = new SdtReader();
    for (const section of sdt) tables.feed(packetize(0x11, section));
    return { networks: nit.networks(), tables: tables.tables() };
  }

  test("TS ごとに中継器と TSID の名前を付け、局名は SDT から", () => {
    const { networks, tables } = read([bsNit()], bsSdt());
    const { channels, skipped } = lineupFrom("BS", networks, tables);
    expect(skipped).toEqual([]);
    expect(channels.map((c) => c.channel)).toEqual([
      "BS01:16400",
      "BS15:16625",
      "BS15:18675",
    ]);
    expect(channels[1]).toEqual({
      type: "BS",
      channel: "BS15:16625",
      networkId: 4,
      transportStreamId: 16625,
      remoteControlKeyId: null,
      services: [
        { serviceId: 101, serviceType: 0x01, name: "NHK BS" },
        // エンジニアリングサービスも残す (取り込みで映像の無いものを落とす。スキャンと同じ)
        { serviceId: 929, serviceType: 0xa4, name: "BS 929" },
      ],
    });
  });

  test("SDT に名前が無い局は前の控えの名前、それも無ければ種別とサービス ID", () => {
    const { networks } = read([bsNit()]);
    const known = knownNames([
      {
        type: "BS",
        channel: "BS15_0",
        networkId: 4,
        transportStreamId: 16625,
        remoteControlKeyId: null,
        services: [{ serviceId: 101, serviceType: 1, name: "ＮＨＫ　ＢＳ" }],
      },
    ]);
    const { channels } = lineupFrom("BS", networks, [], known);
    const names = channels.flatMap((c) => c.services.map((s) => s.name));
    expect(names).toContain("ＮＨＫ　ＢＳ");
    expect(names).toContain("BS 151");
  });

  test("中継器として読めない TS (周波数が無い・ほかの種別) は入れない", () => {
    const { networks } = read([
      nitSection(4, null, [
        [16400, 4, [[151, 0x01]], satelliteDeliveryDescriptor(BS1)],
        [16401, 4, [[161, 0x01]]],
        [16402, 4, [[171, 0x01]], satelliteDeliveryDescriptor(CS2)],
      ]),
    ]);
    const { channels, skipped } = lineupFrom("BS", networks, []);
    expect(channels.map((c) => c.channel)).toEqual(["BS01:16400"]);
    expect(skipped).toEqual([16401, 16402]);
  });

  test("NIT[other] からは作らない (サービスの一覧が無い)", () => {
    const { networks } = read([
      nitSection(7, null, [[28736, 7, [], satelliteDeliveryDescriptor(CS4)]], {
        other: true,
      }),
    ]);
    expect(lineupFrom("CS", networks, []).channels).toEqual([]);
  });
});

describe("中継器を読む", () => {
  test("NIT がそろい、テレビの局の名前がそろったら打ち切る", async () => {
    // 閉じないストリーム (放送は続く)。そろったところで打ち切らないと、時間切れまで待つ
    const started = Date.now();
    const read = await readTables(bsStream(true), 10_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(read.signal).toBe(true);
    expect(read.nit.actual?.transportStreams).toHaveLength(3);
    expect(read.sdt.tables()).toHaveLength(3);
  });

  test("名前がそろわなければ時間切れまで待ち、そこまでのものを返す", async () => {
    const read = await readTables(fromSections([[0x10, bsNit()]], true), 300);
    expect(read.nit.actual).not.toBeNull();
    expect(read.sdt.tables()).toEqual([]);
  });
});

describe("入口から一覧を作る", () => {
  test("BS は入口を前から試し、1 つ読めたら残りは開かない", async () => {
    const opened: string[] = [];
    const lineup = await readLineup(
      "BS",
      async (channel) => {
        opened.push(channel);
        // 最初の入口は受信できない (CATV で通らない中継器など)
        if (channel === "BS15") throw new Error("同期できません");
        return bsStream();
      },
      { timeout: 1_000 },
    );
    expect(opened).toEqual(["BS15", "BS01"]);
    expect(lineup.networks).toEqual([4]);
    expect(lineup.channels).toHaveLength(3);
    expect(lineup.log[0]).toContain("BS15: Error: 同期できません");
  });

  test("CS は NIT[other] の周波数から、もう片方のネットワークの中継器も開く", async () => {
    const opened: string[] = [];
    const net6 = () =>
      fromSections([
        [
          0x10,
          nitSection(6, null, [
            [24608, 6, [[296, 0x01]], satelliteDeliveryDescriptor(CS2)],
          ]),
        ],
        [
          0x10,
          nitSection(
            7,
            null,
            [[28736, 7, [], satelliteDeliveryDescriptor(CS4)]],
            {
              other: true,
            },
          ),
        ],
        // BS のエンジニアリングサービスも NIT[other] に載る (本番)。CS の中継器ではないので開かない
        [
          0x10,
          nitSection(
            4,
            null,
            [[16625, 4, [], satelliteDeliveryDescriptor(BS15)]],
            {
              other: true,
            },
          ),
        ],
        [0x11, sdtSection(24608, 6, [[296, 0x01, "でんぱシネマ"]])],
      ]);
    const net7 = () =>
      fromSections([
        [
          0x10,
          nitSection(7, null, [
            [28736, 7, [[55, 0x01]], satelliteDeliveryDescriptor(CS4)],
          ]),
        ],
        [0x11, sdtSection(28736, 7, [[55, 0x01, "ソラスポーツ"]])],
      ]);
    const lineup = await readLineup(
      "CS",
      async (channel) => {
        opened.push(channel);
        return channel === "CS02" ? net6() : net7();
      },
      { timeout: 1_000 },
    );
    expect(opened).toEqual(["CS02", "CS04"]);
    expect(lineup.networks).toEqual([6, 7]);
    expect(
      lineup.channels.map((c) => [c.channel, c.networkId, c.services[0]?.name]),
    ).toEqual([
      ["CS02:24608", 6, "でんぱシネマ"],
      ["CS04:28736", 7, "ソラスポーツ"],
    ]);
  });

  test("どの入口も読めなければ空の一覧 (控えを書き換えない)", async () => {
    const lineup = await readLineup(
      "BS",
      async () => fromSections([[0x11, sdtSection(16625, 4, [[101, 0x01]])]]),
      { timeout: 200 },
    );
    expect(lineup.networks).toEqual([]);
    expect(lineup.channels).toEqual([]);
    expect(lineup.log).toHaveLength(3);
    expect(lineup.log[0]).toContain("NIT");
  });
});

/** 合成の TS を 1 セクションずつ別のかたまりで返す (実際の放送のように、表が順に届く)。閉じない */
function inChunks(parts: [number, Uint8Array][]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[i];
      if (part === undefined) return new Promise(() => undefined);
      controller.enqueue(packetize(part[0], part[1], i & 0x0f));
      i++;
    },
  });
}

/** CS のネットワーク 6 (CS-2)。NIT[other] にネットワーク 7 (CS-4) と BS (エンジニアリング) が載る */
const cs6Nit = () =>
  nitSection(6, null, [
    [24608, 6, [[296, 0x01]], satelliteDeliveryDescriptor(CS2)],
  ]);
const cs6Sdt = () => sdtSection(24608, 6, [[296, 0x01, "でんぱシネマ"]]);
const cs7Other = () =>
  nitSection(7, null, [[28736, 7, [], satelliteDeliveryDescriptor(CS4)]], {
    other: true,
  });
const bsOther = () =>
  nitSection(4, null, [[16625, 4, [], satelliteDeliveryDescriptor(BS15)]], {
    other: true,
  });
const cs7 = () =>
  fromSections([
    [
      0x10,
      nitSection(7, null, [
        [28736, 7, [[55, 0x01]], satelliteDeliveryDescriptor(CS4)],
      ]),
    ],
    [0x11, sdtSection(28736, 7, [[55, 0x01, "ソラスポーツ"]])],
  ]);

/** 今の控えのチャンネル (ネットワーク 7 は前のバージョンの名前) */
const oldCs7: AgentChannel = {
  type: "CS",
  channel: "CS04",
  networkId: 7,
  transportStreamId: 28736,
  remoteControlKeyId: null,
  services: [{ serviceId: 55, serviceType: 1, name: "ソラスポーツ" }],
};

describe("CS はネットワークを欠かさない", () => {
  test("NIT[other] が NIT[actual] と局名より後に届いても、待ってもう片方のネットワークを開く", async () => {
    const opened: string[] = [];
    const lineup = await readLineup(
      "CS",
      async (channel) => {
        opened.push(channel);
        if (channel !== "CS02") return cs7();
        // actual と局名が先にそろい、BS の NIT[other]、CS の NIT[other] の順に届く
        return inChunks([
          [0x10, cs6Nit()],
          [0x11, cs6Sdt()],
          [0x10, bsOther()],
          [0x10, cs7Other()],
        ]);
      },
      { timeout: 2_000 },
    );
    expect(opened).toEqual(["CS02", "CS04"]);
    expect(lineup.networks).toEqual([6, 7]);
    expect(lineup.missing).toEqual([]);
    expect(lineup.channels.map((c) => c.channel)).toEqual([
      "CS02:24608",
      "CS04:28736",
    ]);
  });

  test("もう片方のネットワークを読めなければ、今のチャンネルを残す", async () => {
    const lineup = await readLineup(
      "CS",
      async (channel) => {
        if (channel !== "CS02") throw new Error("チューナーが空いていません");
        return fromSections([
          [0x10, cs6Nit()],
          [0x10, cs7Other()],
          [0x11, cs6Sdt()],
        ]);
      },
      { timeout: 500, previous: [oldCs7] },
    );
    expect(lineup.networks).toEqual([6]);
    expect(lineup.missing).toEqual([7]);
    expect(lineup.channels.map((c) => [c.channel, c.networkId])).toEqual([
      ["CS02:24608", 6],
      ["CS04", 7],
    ]);
    expect(lineup.log.at(-1)).toContain("ネットワーク 7");
  });

  test("NIT[other] を読めなければ、残りの入口も開く", async () => {
    const opened: string[] = [];
    const lineup = await readLineup(
      "CS",
      async (channel) => {
        opened.push(channel);
        if (channel === "CS04") return cs7();
        return fromSections([
          [0x10, cs6Nit()],
          [0x11, cs6Sdt()],
        ]);
      },
      { timeout: 300 },
    );
    expect(opened).toEqual(["CS02", "CS04", "CS08"]);
    expect(lineup.networks).toEqual([6, 7]);
    expect(lineup.missing).toEqual([]);
  });

  test("NIT[other] を読めず、あるはずのネットワークが読めなければ missing に返す", async () => {
    const lineup = await readLineup(
      "CS",
      async () =>
        fromSections([
          [0x10, cs6Nit()],
          [0x11, cs6Sdt()],
        ]),
      { timeout: 200, expected: [7] },
    );
    expect(lineup.networks).toEqual([6]);
    expect(lineup.missing).toEqual([7]);
    // 控えに無いネットワークは残せるチャンネルが無い
    expect(lineup.channels.map((c) => c.channel)).toEqual(["CS02:24608"]);
  });

  test("NIT[other] に載っていないネットワークは無くなったものとして残さない", async () => {
    const lineup = await readLineup(
      "CS",
      async () =>
        fromSections([
          [0x10, cs6Nit()],
          [0x10, bsOther()],
          [
            0x10,
            nitSection(
              8,
              null,
              [[30000, 8, [], satelliteDeliveryDescriptor(CS4)]],
              { other: true },
            ),
          ],
          [0x11, cs6Sdt()],
        ]),
      { timeout: 200, previous: [oldCs7] },
    );
    // ネットワーク 8 は CS-4 を開いても 7 しか来ないので読めない。7 は NIT[other] に無いので残さない
    expect(lineup.missing).toEqual([8]);
    expect(lineup.channels.map((c) => c.networkId)).toEqual([6]);
  });
});

describe("放送の一覧から入れるか", () => {
  const entry = (type: "BS" | "CS" | "GR", channel: string) =>
    ({ type, channel, services: [] }) as unknown as AgentChannel;

  test("局が無い種別と、前のバージョンの名前が残っている種別を作り直す", () => {
    expect(needsLineup([entry("GR", "T27")], "BS")).toBe(true);
    expect(needsLineup([entry("BS", "BS15_0")], "BS")).toBe(true);
    expect(needsLineup([entry("CS", "CS02")], "CS")).toBe(true);
    expect(
      needsLineup([entry("BS", "BS15:16625"), entry("BS", "BS01:16400")], "BS"),
    ).toBe(false);
    // 1 つでも前の名前が混ざっていれば作り直す (選局できない)
    expect(
      needsLineup([entry("BS", "BS15:16625"), entry("BS", "BS01_0")], "BS"),
    ).toBe(true);
  });
});

describe("一覧から落ちたネットワークを作り直す", () => {
  const cs = (channel: string, networkId: number) =>
    ({
      type: "CS",
      channel,
      networkId,
      transportStreamId: 0,
      remoteControlKeyId: null,
      services: [],
    }) satisfies AgentChannel;
  // エージェントの一覧はネットワーク 6 だけ。局の表にはネットワーク 7 が前の名前で残っている
  const channels = [cs("CS02:24608", 6), cs("CS08:24704", 6)];
  const stored = [
    { type: "CS", network_id: 6, channel: "CS02:24608" },
    { type: "CS", network_id: 7, channel: "CS04" },
    { type: "CS", network_id: 7, channel: "CS06" },
    { type: "BS", network_id: 4, channel: "BS15_0" },
  ];

  test("局の表に前の名前で残っていて一覧に無いネットワークを、読みに行くネットワークにする", () => {
    expect(leftoverNetworks(channels, "CS", stored)).toEqual([7]);
    expect(needsLineup(channels, "CS", stored)).toBe(true);
  });

  test("一覧にあるネットワークの前の名前と、ほかの種別の行は見ない", () => {
    expect(
      needsLineup(
        [...channels, cs("CS04:28736", 7)],
        "CS",
        stored.filter((row) => row.type !== "BS"),
      ),
    ).toBe(false);
    expect(
      leftoverNetworks([{ ...cs("BS15:16625", 4), type: "BS" }], "BS", [
        { type: "CS", network_id: 7, channel: "CS04" },
      ]),
    ).toEqual([]);
  });
});
