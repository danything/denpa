import { describe, expect, test } from "bun:test";

import { concatBytes } from "@danything/arib/bytes";
import { EpgReader } from "@danything/arib/eit";
import { MmtEpgReader } from "@danything/arib/mh-eit";
import {
  eitSection,
  nitSection,
  packetize,
  patSection,
  programMap,
  sdtSection,
} from "@danything/arib/synth";
import {
  compressedIp,
  m2SectionMessage,
  mhEitSection,
  mhSdtSection,
  mptTable,
  paMessage,
  pltTable,
  signalingPackets,
  tlvNitSection,
  tlvPacket,
  tlvSi,
} from "@danything/arib/synth-mmt";

import { CaObserver } from "./ca-observe";
import {
  catvChannels,
  channelEntry,
  channelsFor,
  dedupeCatv,
  readServices,
  readTlvServices,
  scanTargets,
  skyChannels,
  tsmfJobs,
} from "./scan";
import {
  type AgentChannel,
  epgReadableChannel,
  serviceAbilities,
} from "./tuner";

/**
 * 総当たりそのもの (`Scanner`) はここでは試さない。**エージェントに選局を
 * 任せる形**になったので、相手がいないと動かない。通しで見ているのは
 * `tests/e2e/16-scan.spec.ts` で、本物の総当たりが偽の放送に当たっている。
 */

/** NIT と SDT だけの TS。チューナーが出すものの代わり */
function stream(
  services: [number, number, string?][],
  half = false,
): Uint8Array {
  return Uint8Array.from([
    // 頭に無関係なパケットを混ぜておく。すぐには揃わない状況にするため
    ...packetize(0x0100, sdtSection(0x0408, 0x0004, services)),
    ...(half
      ? []
      : [
          ...packetize(
            0x0010,
            nitSection(0x7fe0, 6, [[0x0408, 0x0004, [[1024, 0x01]]]]),
          ),
        ]),
    ...packetize(0x0011, sdtSection(0x0408, 0x0004, services), 3),
  ]);
}

/** バイト列をそのまま返すリーダー。選局の代わり */
function fromBytes(
  data: Uint8Array,
  keepOpen = false,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      if (!keepOpen) controller.close();
    },
  });
}

describe("選局するチャンネル", () => {
  test("地上波は 13〜62ch", () => {
    const channels = channelsFor("GR");
    expect(channels[0]).toBe("T13");
    expect(channels.at(-1)).toBe("T62");
    expect(channels).toHaveLength(50);
  });

  test("パススルーも選ぶと UHF に続けて C13〜C63", () => {
    const catv = channelsFor("PASSTHROUGH");
    expect(catv.slice(0, 50)).toEqual(channelsFor("GR"));
    expect(catv.slice(50)).toEqual(
      Array.from({ length: 51 }, (_, i) => `C${13 + i}`),
    );
  });

  test("同じ種別を 2 回選んでも 1 回だけ回す", () => {
    expect(scanTargets(["BS", "BS", "CS"])).toEqual([
      ["BS", ["BS"]],
      ["CS", ["CS"]],
    ]);
  });

  test("地上波とパススルーを両方選ぶと、UHF を 2 回回さずパススルーのほうだけにする", () => {
    expect(scanTargets(["GR", "PASSTHROUGH"])).toEqual([
      ["GR", channelsFor("PASSTHROUGH")],
    ]);
  });

  test("ケーブルは QC13〜QC63・QU13〜QU62・QV1〜QV12 の 113 本を、種別 CATV で総当たりする", () => {
    const catv = catvChannels();
    expect(catv).toHaveLength(113);
    expect(catv.slice(0, 2)).toEqual(["QC13", "QC14"]);
    expect(catv[50]).toBe("QC63");
    expect(catv[51]).toBe("QU13");
    expect(catv[100]).toBe("QU62");
    expect(catv.slice(-2)).toEqual(["QV11", "QV12"]);
    expect(scanTargets(["PASSTHROUGH", "CATV"])).toEqual([
      ["GR", channelsFor("PASSTHROUGH")],
      ["CATV", catv],
    ]);
  });

  test("TSMF で束ねた搬送波は、2 つ目からの TS を番号を付けて回す", () => {
    expect(tsmfJobs("QC30", 3)).toEqual(["QC30:1", "QC30:2"]);
    // 束ねていない (ヘッダが無い)・C13〜C63 の周波数でない・もう番号の付いたものは足さない
    expect(tsmfJobs("QC30", 1)).toEqual([]);
    expect(tsmfJobs("QU30", 3)).toEqual([]);
    expect(tsmfJobs("QC30:1", 3)).toEqual([]);
  });

  test("同じ TS が 2 つの CATV のチャンネルで見つかったら、先のほうだけを残す", () => {
    const entry = (
      type: AgentChannel["type"],
      channel: string,
      transportStreamId: number,
    ): AgentChannel => ({
      type,
      channel,
      networkId: 4,
      transportStreamId,
      remoteControlKeyId: null,
      services: [],
    });
    const { kept, dropped } = dedupeCatv([
      entry("BS", "BS01:16400", 16400),
      entry("CATV", "QC30", 16400),
      entry("CATV", "QC30:1", 16401),
      entry("CATV", "QU40", 16400),
    ]);
    // アンテナの BS とは比べない (ID が別なのでぶつからない)
    expect(kept.map((e) => e.channel)).toEqual([
      "BS01:16400",
      "QC30",
      "QC30:1",
    ]);
    expect(dropped.map((d) => [d.entry.channel, d.kept])).toEqual([
      ["QU40", "QC30"],
    ]);
  });

  test("SKY はエージェントの選局表の H01〜H105 を総当たりする", () => {
    const sky = skyChannels();
    expect(sky).toHaveLength(105);
    expect(sky.slice(0, 2)).toEqual(["H01", "H02"]);
    expect(sky.slice(-2)).toEqual(["H104", "H105"]);
    expect(scanTargets(["GR", "SKY"])).toEqual([
      ["GR", channelsFor("GR")],
      ["SKY", sky],
    ]);
  });
});

describe("チャンネル定義の組み立て", () => {
  test("見つけたサービスを局名ごと並べる", () => {
    const entry = channelEntry("GR", "T27", [
      {
        serviceId: 1032,
        serviceType: 1,
        name: "TOKYO MX2",
        networkId: 32391,
        transportStreamId: 23608,
        remoteControlKeyId: 9,
      },
      {
        serviceId: 1024,
        serviceType: 1,
        name: "TOKYO MX1",
        networkId: 32391,
        transportStreamId: 23608,
        remoteControlKeyId: 9,
      },
    ]);
    expect(entry).toEqual({
      type: "GR",
      channel: "T27",
      networkId: 32391,
      transportStreamId: 23608,
      remoteControlKeyId: 9,
      services: [
        { serviceId: 1024, serviceType: 1, name: "TOKYO MX1" },
        { serviceId: 1032, serviceType: 1, name: "TOKYO MX2" },
      ],
    });
  });
});

describe("1 チャンネルの読み取り", () => {
  test("局を探しているあいだに流れてきた番組表も取得する", async () => {
    const epg = new EpgReader();
    const eit = eitSection({
      tableId: 0x50,
      serviceId: 1024,
      transportStreamId: 0x0408,
      originalNetworkId: 0x7fe0,
      events: [
        {
          eventId: 1,
          startAt: Date.now() + 3600_000,
          duration: 1800_000,
          name: "集めた番組",
        },
      ],
    });
    const data = Uint8Array.from([
      ...packetize(0x0012, eit),
      ...stream([[1024, 0x01, "TOKYO MX1"]]),
    ]);
    const { error } = await readServices(fromBytes(data), 5000, undefined, epg);
    expect(error).toBeNull();
    expect(epg.all().map((e) => e.name)).toEqual(["集めた番組"]);
  });

  test("流れてきた TS からサービスを読む", async () => {
    const { services, error } = await readServices(
      fromBytes(
        stream([
          [1024, 0x01, "TOKYO MX1"],
          [1025, 0x01],
        ]),
      ),
      5000,
    );
    expect(error).toBeNull();
    expect(services?.map((s) => s.serviceId)).toEqual([1024, 1025]);
    expect(services?.[0]?.name).toBe("TOKYO MX1");
    expect(services?.[0]?.remoteControlKeyId).toBe(6);
  });

  test("何も出てこなければ受信できていない", async () => {
    const { services, error } = await readServices(
      fromBytes(new Uint8Array(0)),
      500,
    );
    expect(services).toBeNull();
    expect(error).toBe("受信できませんでした");
  });

  test("片方しか来なければ諦める", async () => {
    // SDT だけ。どのネットワークのものか分からないので設定には書けない
    const { services, error, signal } = await readServices(
      fromBytes(stream([[1024, 0x01]], true), true),
      500,
    );
    expect(services).toBeNull();
    // 「受信できませんでした」で片付けない。電波は来ているので疑うところが違う
    expect(signal).toBe(true);
    expect(error).toBe("NIT を受信できませんでした");
  });

  test("失敗した理由を持ち帰る", async () => {
    // 選局が落ちた理由 (「デバイスが使用中」など) を捨てると原因が分からない
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("Cannot open device"));
      },
    });
    const { error, signal } = await readServices(failing, 5000);
    expect(signal).toBe(false);
    expect(error).toContain("Cannot open device");
  });

  test("揃った時点で打ち切る", async () => {
    // ある局で毎回 30 秒待っていたら総当たりが終わらない。**閉じないリーダー**で試す
    const started = Bun.nanoseconds();
    const { error } = await readServices(
      fromBytes(stream([[1024, 0x01]]), true),
      30_000,
    );
    expect(error).toBeNull();
    expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(10);
  });

  test("読み終えたら、走査の打ち切りのリスナーを外す", async () => {
    // 合図は走査全体で 1 つ。局ごとに足したまま残すと、総当たりで 100 を超えて積もる
    const { signal } = new AbortController();
    const listening = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      listening.add(args[1]);
      add(...args);
    }) as typeof add;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      listening.delete(args[1]);
      remove(...args);
    }) as typeof remove;
    for (let i = 0; i < 3; i++)
      await readServices(fromBytes(stream([[1024, 0x01]])), 5000, signal);
    expect(listening.size).toBe(0);
  });
});

describe("SKY の局で、カード無しで分かること", () => {
  test("局が揃ったあとに来た番組表も数え、番組表の具合が分かった時点で打ち切る", async () => {
    const observer = new CaObserver();
    const eit = eitSection({
      tableId: 0x4e,
      serviceId: 1024,
      transportStreamId: 0x0408,
      originalNetworkId: 0x7fe0,
      events: [],
    });
    const started = Bun.nanoseconds();
    const { error } = await readServices(
      fromBytes(
        Uint8Array.from([...stream([[1024, 0x01]]), ...packetize(0x0012, eit)]),
        true,
      ),
      30_000,
      undefined,
      undefined,
      observer,
    );
    expect(error).toBeNull();
    expect(observer.result().epg).toBe("readable");
    expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(5);
  });

  test("番組表が来ないまま流れが終われば、局はそのまま入れて番組表は来ていないとする", async () => {
    const observer = new CaObserver();
    const { services, error } = await readServices(
      fromBytes(stream([[1024, 0x01]])),
      5000,
      undefined,
      undefined,
      observer,
    );
    expect(error).toBeNull();
    expect(services?.map((s) => s.serviceId)).toEqual([1024]);
    expect(observer.result().epg).toBe("absent");
  });
});

describe("ケーブルの局", () => {
  /** CA 記述子 (0x09)。CA_system_id と ECM の PID */
  const ca = (system: number, pid: number) => [
    0x09,
    0x04,
    system >> 8,
    system & 0xff,
    0xe0 | (pid >> 8),
    pid & 0xff,
  ];

  test("NIT が来なくても SDT で揃い、局ごとの CA_system_id を PMT から入れる", async () => {
    const observer = new CaObserver();
    const data = Uint8Array.from([
      ...packetize(
        0x0000,
        patSection(
          [
            [151, 0x0101],
            [152, 0x0102],
          ],
          16400,
        ),
      ),
      // BS の再送信。B-CAS で掛かった局と、B-CAS 以外の方式で掛かった局
      ...packetize(0x0101, programMap(151, 0x0111, [[0x02, 0x0111]], 0x0901)),
      ...packetize(
        0x0102,
        programMap(
          152,
          0x0112,
          [[0x02, 0x0112]],
          undefined,
          ca(0x000a, 0x0902),
        ),
      ),
      ...packetize(
        0x0011,
        sdtSection(16400, 4, [
          [151, 0x01, "BS朝日1"],
          [152, 0x01, "BS朝日2"],
        ]),
      ),
      // 番組表 (EIT[p/f])。スクランブルされずに来たので、どちらの局も番組表を読める
      ...packetize(
        0x0012,
        eitSection({
          tableId: 0x4e,
          serviceId: 152,
          transportStreamId: 16400,
          originalNetworkId: 4,
          events: [],
        }),
      ),
    ]);
    const { services, error } = await readServices(
      fromBytes(data, true),
      30_000,
      undefined,
      undefined,
      observer,
      true,
    );
    expect(error).toBeNull();
    // 元の放送の original_network_id (BS は 4) をそのまま使う
    expect(services?.map((s) => [s.serviceId, s.networkId])).toEqual([
      [151, 4],
      [152, 4],
    ]);
    const entry = channelEntry(
      "CATV",
      "QC30",
      services!,
      (id) => observer.caSystemIdsOf(id),
      "ts",
      observer.result().epg === "readable",
    );
    expect(entry.networkId).toBe(4);
    expect(entry.services.map((s) => s.caSystemIds)).toEqual([
      [0x0005],
      [0x000a],
    ]);
    expect(entry.services.map((s) => s.epgReadable)).toEqual([true, true]);
    // B-CAS 以外の方式の局 (152) は復号できないが、番組表は読めるので番組表に出す
    expect(entry.services.map((s) => serviceAbilities(entry, s))).toEqual([
      { decodable: true, epgReadable: true },
      { decodable: false, epgReadable: true },
    ]);
  });

  test("PAT に局が 1 つも無い TS は、待たずに局なしで返す", async () => {
    const started = Bun.nanoseconds();
    const { services, error } = await readServices(
      fromBytes(
        Uint8Array.from(packetize(0x0000, patSection([], 16400))),
        true,
      ),
      30_000,
      undefined,
      undefined,
      new CaObserver(),
      true,
    );
    expect(error).toBeNull();
    expect(services).toEqual([]);
    expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(10);
  });

  test("SDT が来なければ SDT が無いと返す (NIT は見ない)", async () => {
    const { services, error } = await readServices(
      fromBytes(stream([[1024, 0x01]], true).slice(0, 188), true),
      500,
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(services).toBeNull();
    expect(error).toBe("SDT を受信できませんでした");
  });
});

/**
 * ケーブルで受けた 4K の局。エージェントは TSMF から選んだ分割 TLV を TLV のバイト列に組み立てて、`application/x-arib-tlv` で流す。
 * 値は実機 (QC26 の BS4K) のもの
 */
describe("ケーブルの 4K の局 (TLV)", () => {
  const ONID = 0x000b;
  const TLV_STREAM = 0xb111;
  const SERVICE = 161;
  const ip = (bytes: Uint8Array) => compressedIp(1, bytes);
  const nit = tlvSi(
    tlvNitSection(ONID, "高度ＢＳデジタル放送", [
      [TLV_STREAM, ONID, [[SERVICE, 1]]],
    ]),
  );
  const sdt = signalingPackets(0x8004, [
    m2SectionMessage(
      mhSdtSection(TLV_STREAM, ONID, [
        { serviceId: SERVICE, name: "ＢＳでんぱ　４Ｋ" },
      ]),
    ),
  ]).map(ip);
  const plt = signalingPackets(0x0000, [
    paMessage(pltTable([[SERVICE, 0xff01]])),
  ]).map(ip);
  const mpt = signalingPackets(0xff01, [
    paMessage(
      mptTable({
        packageId: SERVICE,
        access: { caSystemId: 0x0005, ecmPacketId: 0xfff1 },
        assets: [{ type: "hev1", packetId: 0xf100 }],
      }),
    ),
  ]).map(ip);
  /** 番組表 (MH-EIT の予定)。信号のメッセージで来て、スクランブルされない */
  const eit = signalingPackets(0x8000, [
    m2SectionMessage(
      mhEitSection({
        tableId: 0x8c,
        serviceId: SERVICE,
        tlvStreamId: TLV_STREAM,
        originalNetworkId: ONID,
        events: [
          {
            eventId: 1,
            startAt: Date.UTC(2026, 10, 11, 10, 30),
            duration: 60 * 60_000,
            name: "4K のテスト番組",
          },
        ],
      }),
    ),
  ]).map(ip);

  test("TLV-NIT と MH-SDT で局が入り、MPT の CA_system_id 0x0005 の局は復号できないが、番組表 (MH-EIT) は読める", async () => {
    const started = Bun.nanoseconds();
    const epg = new MmtEpgReader();
    const result = await readTlvServices(
      fromBytes(concatBytes([nit, ...plt, ...mpt, ...eit, ...sdt]), true),
      30_000,
      undefined,
      epg,
    );
    expect(result.error).toBeNull();
    // MPT まで揃ったら、局の情報を待つ上限まで読まずに打ち切る
    expect((Bun.nanoseconds() - started) / 1e9).toBeLessThan(5);
    const entry = channelEntry(
      "CATV",
      "QC26",
      result.services!,
      result.caSystemIdsOf,
      "tlv",
      true,
    );
    expect(entry).toEqual({
      type: "CATV",
      channel: "QC26",
      networkId: ONID,
      transportStreamId: TLV_STREAM,
      remoteControlKeyId: null,
      transport: "tlv",
      services: [
        {
          serviceId: SERVICE,
          serviceType: 1,
          name: "ＢＳでんぱ　４Ｋ",
          caSystemIds: [0x0005],
          epgReadable: true,
        },
      ],
    });
    // 4K の局 (TLV) は、B-CAS と同じ 0x0005 でも ACAS が要るので復号できない。
    // 番組表は読めるので、番組表の取得には行く
    expect(serviceAbilities(entry, entry.services[0]!)).toEqual({
      decodable: false,
      epgReadable: true,
    });
    expect(epgReadableChannel(entry)).toBe(true);
    // TS の CATV の局なら、同じ CA_system_id で復号できる
    expect(
      serviceAbilities({ ...entry, transport: "ts" }, entry.services[0]!)
        .decodable,
    ).toBe(true);
    // 同じストリームから番組表 (MH-EIT) も読める
    expect(epg.all().map((event) => [event.serviceId, event.name])).toEqual([
      [SERVICE, "4K のテスト番組"],
    ]);
  });

  test("TS のチャンネルの控えには transport を書かない", () => {
    const entry = channelEntry("CATV", "QC30", [], undefined);
    expect("transport" in entry).toBe(false);
  });

  test("MH-SDT が来なければ MH-SDT が無いと返す", async () => {
    const result = await readTlvServices(
      fromBytes(concatBytes([nit, ...plt, ...mpt]), true),
      500,
    );
    expect(result.services).toBeNull();
    expect(result.error).toBe("MH-SDT を受信できませんでした");
  });

  test("TLV-NIT が来なければ TLV-NIT が無いと返す", async () => {
    const result = await readTlvServices(
      // 同期を取る最初のパケットは、次のパケットの先頭が届くまで出ない (`TlvStream`)
      fromBytes(concatBytes([...sdt, tlvPacket(0xff, [0, 0])]), true),
      500,
    );
    expect(result.services).toBeNull();
    expect(result.error).toBe("TLV-NIT を受信できませんでした");
  });
});
