import { describe, expect, test } from "bun:test";

import type { AgentChannel } from "./tuner";

/**
 * どのチャンネルを集めに行くか。
 *
 * **ここが実機で暴走した。** 番組表が7日先まで埋まっているのに、30分ごとの
 * 周回で毎回ほぼ全チャンネルが選ばれ、1本ぶんの上限まで開きっぱなしに
 * なっていた ([config.ts](config.ts) の epgChannelTimeout)。
 */
const { config } = await import("./config");
const {
  firstSweeps,
  lastOf,
  networkSweeps,
  pickChannels,
  reachOf,
  replacement,
  sweepOrder,
} = await import("./epg-collect");
const { serviceKey } = await import("./tuner");

const NETWORK = 32391;

function channel(name: string, services: number[]): AgentChannel {
  return {
    type: "GR",
    channel: name,
    networkId: NETWORK,
    transportStreamId: NETWORK,
    remoteControlKeyId: 9,
    services: services.map((serviceId) => ({
      serviceId,
      serviceType: 1,
      name: `局${serviceId}`,
    })),
  } as AgentChannel;
}

describe("どこまで埋まっているか", () => {
  const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
  const WEEK = NOW + 7 * 24 * 3600_000;

  test("入っている局のうち、いちばん薄いものに合わせる", () => {
    const reach = new Map([
      [serviceKey(NETWORK, 23608), WEEK],
      [serviceKey(NETWORK, 23610), NOW],
    ]);

    expect(reachOf(reach, channel("T16", [23608, 23610]))).toBe(NOW);
  });

  /*
   * エージェントは TS にある全部の局を返すが、denpa は映像の入っていない局を
   * 落とす (`epg.syncServices`)。数に入れていた頃は「0 まで埋まっている =
   * いちばん薄い」と読んで、データ放送を積んでいる地上波が丸ごと毎周回の
   * 対象になっていた
   */
  test("番組表に出てこない局は数えない", () => {
    const reach = new Map([[serviceKey(NETWORK, 23608), WEEK]]);

    // 23611 はデータ放送。denpa の services には無い
    expect(reachOf(reach, channel("T16", [23608, 23611]))).toBe(WEEK);
  });

  test("1局も知らないチャンネルはまっさら扱い", () => {
    expect(reachOf(new Map(), channel("T16", [23608]))).toBe(0);
  });
});

describe("pickChannels", () => {
  const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
  /** 番組表が薄い (まっさら) チャンネル */
  const thin = () => 0;
  /** 7日先まで埋まっているチャンネル */
  const full = () => NOW + 7 * 24 * 3600_000;

  test("薄いチャンネルから先に行く", () => {
    const channels = [channel("T16", [1]), channel("T25", [2])];
    const reach = new Map([
      ["T16", NOW + 5 * 24 * 3600_000],
      ["T25", NOW],
    ]);

    expect(
      pickChannels(
        channels,
        (c) => reach.get(c.channel) ?? 0,
        () => 0,
        NOW,
      ).map((c) => c.channel),
    ).toEqual(["T25", "T16"]);
  });

  test("埋まっていて、行ったばかりのチャンネルは行かない", () => {
    expect(pickChannels([channel("T16", [1])], full, () => NOW, NOW)).toEqual(
      [],
    );
  });

  /*
   * **実機に受信できない CS が 24 局残っていた。** 開いても EIT が1件も来ない
   * ので永久に薄いままで、「薄いから行く」だけで選んでいた頃は周回のたびに
   * 選ばれ、上限まで開きっぱなしになっていた
   */
  test("薄くても、行った直後は行き直さない", () => {
    const justNow = NOW - config.epgChannelRetry + 1;

    expect(
      pickChannels([channel("CS08", [55])], thin, () => justNow, NOW),
    ).toEqual([]);
  });

  test("休ませる時間が過ぎたら、薄いところへは行き直す", () => {
    const before = NOW - config.epgChannelRetry - 1;

    expect(
      pickChannels([channel("CS08", [55])], thin, () => before, NOW).map(
        (c) => c.channel,
      ),
    ).toEqual(["CS08"]);
  });

  test("埋まっていても、しばらく行っていなければ行く。当日ぶんは直前まで書き換わる", () => {
    const stale = NOW - config.epgChannelInterval - 1;

    expect(
      pickChannels([channel("T16", [1])], full, () => stale, NOW).map(
        (c) => c.channel,
      ),
    ).toEqual(["T16"]);
  });
});

/*
 * **最後に集めた時刻は局から引く。**
 *
 * `services.channel` に入るのは「最後に取り込んだときの枠の名前」1つだけなので、
 * 同じ TS を指す枠が2つあると片方が必ず「一度も集めていない」ことになる。
 * 実機の BS がまさにそれで、9枠が永久にまっさらに見えて周回のたびに開かれていた。
 */
describe("最後に集めた時刻", () => {
  const AT = Date.UTC(2026, 7, 4, 3, 0, 0);

  test("入っている局のうち、いちばん新しいものを採る", () => {
    const perService = new Map([
      [serviceKey(NETWORK, 101), AT - 60_000],
      [serviceKey(NETWORK, 102), AT],
    ]);

    expect(lastOf(perService, channel("BS01_0", [101, 102]))).toBe(AT);
  });

  test("同じ局を指す別の枠からでも、同じ時刻が出る", () => {
    const perService = new Map([[serviceKey(NETWORK, 101), AT]]);

    expect(lastOf(perService, channel("BS01_3", [101]))).toBe(AT);
  });

  test("1件も入っていなければ「まっさら」", () => {
    expect(lastOf(new Map(), channel("BS01_0", [101]))).toBe(0);
  });
});

describe("初回は BS をネットワークごとに1中継で埋める", () => {
  const BS = 4;
  const sat = (name: string, networkId: number, services: number[]) =>
    ({
      ...channel(name, services),
      type: networkId === BS ? "BS" : "CS",
      networkId,
    }) as AgentChannel;
  const channels = [
    channel("T16", [1024]),
    sat("BS01_0", BS, [101]),
    sat("BS03_0", BS, [151]),
    sat("CS02", 6, [296]),
    sat("CS04", 7, [55]),
  ];

  test("番組が1件も無いネットワークから、1つずつ選ぶ (地上波と CS は対象外)", () => {
    expect(firstSweeps(channels, new Map()).map((c) => c.channel)).toEqual([
      "BS01_0",
    ]);
  });

  test("いちばん長く行っていない中継を選ぶ (受信できない中継に当たり続けない)", () => {
    const last = (c: AgentChannel) => (c.channel === "BS01_0" ? Date.now() : 0);
    expect(firstSweeps(channels, new Map(), last)[0]?.channel).toBe("BS03_0");
  });

  test("1局でも埋まっているネットワークは選ばない (受信できない局が残っていても)", () => {
    const reach = new Map([[serviceKey(BS, 151), Date.now()]]);
    expect(firstSweeps(channels, reach)).toEqual([]);
  });

  /*
   * CS は詳細を流していないので、中継ごとに開かずいつも全局読み。
   * 選ばれた中継が1つでもあるネットワークを、受信を確かめていない順の1中継にまとめる
   */
  const cs = [
    sat("CS02", 6, [296]),
    sat("CS06", 6, [227]),
    sat("CS04", 7, [55]),
    sat("CS08", 7, [800]),
  ];

  test("CS はネットワークごとに1中継へまとめる", () => {
    const checked = (c: AgentChannel) =>
      c.channel === "CS02" ? Date.now() : 0;
    expect(
      networkSweeps([cs[0]!, channels[1]!], cs, checked).map((c) => c.channel),
    ).toEqual(["CS06"]);
    expect(
      networkSweeps([cs[0]!, cs[3]!], cs, checked).map((c) => c.channel),
    ).toEqual(["CS06", "CS04"]);
  });

  /*
   * 番組の行の時刻は全局読みでネットワークの全中継が同じになる。確かめた時刻で選ぶので、
   * 周回のたびに次の中継へ移り、どの中継も受信を確かめられる (「確認中」のまま残らない)
   */
  test("周回のたびに、まだ確かめていない中継へ順に移る", () => {
    const network6 = [
      sat("CS02", 6, [296]),
      sat("CS08", 6, [800]),
      sat("CS10", 6, [227]),
    ];
    const checked = new Map<string, number>();
    const opened: string[] = [];
    for (let round = 1; round <= 4; round++) {
      const [pick] = networkSweeps(
        network6,
        network6,
        (c) => checked.get(c.channel) ?? 0,
      );
      opened.push(pick!.channel);
      checked.set(pick!.channel, round);
    }
    expect(opened).toEqual(["CS02", "CS08", "CS10", "CS02"]);
  });

  test("全局読みが受信できなければ、同じ周回で次の中継に替える (ネットワークごとに1回)", () => {
    const order = (network: number) => sweepOrder(cs, network, () => 0);
    const replaced = new Set<number>();
    const job = { channel: cs[0]!, whole: [296, 227] };

    expect(replacement(job, true, replaced, order)).toEqual({
      channel: cs[1]!,
      whole: [296, 227],
    });
    // 替えた先も受信できなかった。アンテナの不調かもしれないので、残りを全部は開かない
    expect(
      replacement({ ...job, channel: cs[1]! }, true, replaced, order),
    ).toBeUndefined();
    // ほかのネットワークは別に数える
    expect(
      replacement({ channel: cs[2]!, whole: [55] }, true, replaced, order)
        ?.channel,
    ).toBe(cs[3]);
  });

  test("受信できた・全局読みでない・BS のときは替えない", () => {
    const order = (network: number) => sweepOrder(cs, network, () => 0);
    expect(
      replacement({ channel: cs[0]!, whole: [296] }, false, new Set(), order),
    ).toBeUndefined();
    expect(
      replacement({ channel: cs[0]!, whole: null }, true, new Set(), order),
    ).toBeUndefined();
    expect(
      replacement(
        { channel: channels[1]!, whole: [101] },
        true,
        new Set(),
        order,
      ),
    ).toBeUndefined();
  });
});
