import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { concatBytes } from "@danything/arib/bytes";
import {
  compressedIp,
  m2SectionMessage,
  mhEitSection,
  signalingPackets,
  tlvPacket,
} from "@danything/arib/synth-mmt";

import type { Last, Outcome } from "./epg-collect";
import type { AgentChannel } from "./tuner";

/**
 * どのチャンネルを集めに行くか。
 *
 * **ここが実機で止まらなくなった。** 番組表が 7 日先まで埋まっているのに、30 分ごとの
 * 周回で毎回ほぼ全チャンネルが選ばれ、1 本ぶんの上限まで開きっぱなしに
 * なっていた ([config.ts](config.ts) の epgChannelTimeout)。
 */
const { config } = await import("./config");
// 番組表を集める回 (`collectOnce`) は DB に書く。置き場は一時ディレクトリに (`./fake-agent` の証明書もここ)
const testDir = mkdtempSync(join(tmpdir(), "denpa-epg-collect-"));
const realAgent = config.agentUrl;
config.dataDir = testDir;
config.dbPath = join(testDir, "denpa.db");
afterAll(() => {
  config.agentUrl = realAgent;
  rmSync(testDir, { recursive: true, force: true });
});
const {
  collectOnce,
  drain,
  firstSweepDone,
  firstSweeps,
  laneTypes,
  receptionFailed,
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
      [serviceKey(NETWORK, 23608, "GR"), WEEK],
      [serviceKey(NETWORK, 23610, "GR"), NOW],
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
    const reach = new Map([[serviceKey(NETWORK, 23608, "GR"), WEEK]]);

    // 23611 はデータ放送。denpa の services には無い
    expect(reachOf(reach, channel("T16", [23608, 23611]))).toBe(WEEK);
  });

  test("1 局も知らないチャンネルはまっさら扱い", () => {
    expect(reachOf(new Map(), channel("T16", [23608]))).toBe(0);
  });
});

describe("pickChannels", () => {
  const NOW = Date.UTC(2026, 7, 4, 3, 0, 0);
  /** 番組表が薄い (まっさら) チャンネル */
  const thin = () => 0;
  /** 7 日先まで埋まっているチャンネル */
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
   * **実機に受信できない CS が 24 局残っていた。** 開いても EIT が 1 件も来ない
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
 * `services.channel` に入るのは「最後に取り込んだときの枠の名前」1 つだけなので、
 * 同じ TS を指す枠が 2 つあると片方が必ず「一度も集めていない」ことになる。
 * 実機の BS がまさにそれで、9 枠が永久にまっさらに見えて周回のたびに開かれていた。
 */
describe("最後に集めた時刻", () => {
  const AT = Date.UTC(2026, 7, 4, 3, 0, 0);

  test("入っている局のうち、いちばん新しいものを採る", () => {
    const perService = new Map([
      [serviceKey(NETWORK, 101, "GR"), AT - 60_000],
      [serviceKey(NETWORK, 102, "GR"), AT],
    ]);

    expect(lastOf(perService, channel("BS01_0", [101, 102]))).toBe(AT);
  });

  test("同じ局を指す別の枠からでも、同じ時刻が出る", () => {
    const perService = new Map([[serviceKey(NETWORK, 101, "GR"), AT]]);

    expect(lastOf(perService, channel("BS01_3", [101]))).toBe(AT);
  });

  test("1 件も入っていなければ「まっさら」", () => {
    expect(lastOf(new Map(), channel("BS01_0", [101]))).toBe(0);
  });
});

describe("初回は BS をネットワークごとに 1 中継で埋める", () => {
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

  test("番組が 1 件も無いネットワークから、1 つずつ選ぶ (地上波と CS は対象外)", () => {
    expect(firstSweeps(channels, new Map()).map((c) => c.channel)).toEqual([
      "BS01_0",
    ]);
  });

  test("いちばん長く行っていない中継を選ぶ (受信できない中継に当たり続けない)", () => {
    const last = (c: AgentChannel) => (c.channel === "BS01_0" ? Date.now() : 0);
    expect(firstSweeps(channels, new Map(), last)[0]?.channel).toBe("BS03_0");
  });

  test("1 局でも埋まっているネットワークは選ばない (受信できない局が残っていても)", () => {
    const reach = new Map([[serviceKey(BS, 151, "BS"), Date.now()]]);
    expect(firstSweeps(channels, reach)).toEqual([]);
  });

  /*
   * CS は詳細を流していないので、中継ごとに開かずいつも全局読み。
   * 選ばれた中継が 1 つでもあるネットワークを、受信を確かめていない順の 1 中継にまとめる
   */
  const cs = [
    sat("CS02", 6, [296]),
    sat("CS06", 6, [227]),
    sat("CS04", 7, [55]),
    sat("CS08", 7, [800]),
  ];

  test("CS はネットワークごとに 1 中継へまとめる", () => {
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

  test("全局読みが受信できなければ、同じ周回で次の中継に替える (ネットワークごとに 1 回)", () => {
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

/*
 * 初回の全局読みが揃わずに切れると、同じ中継を自分の中継ぶんだけ読み直す (`whole: null` で列へ戻す)。
 * その読み直しも数えていた頃は、ほかの全局読みが終わる前に「詳細はあとで足す」が消えていた
 */
describe("初回の全局読みを数える (firstSweepDone)", () => {
  const bs = (name: string) =>
    ({ ...channel(name, [101]), type: "BS", networkId: 4 }) as AgentChannel;
  const first = [bs("BS01_0"), bs("BS03_0")];

  test("初回の全局読みを終えたら数え、列へ戻した読み直しは数えない", () => {
    const jobs = [
      { channel: first[0]!, whole: [101] },
      // 揃わずに切れたので、同じ中継を読み直す
      { channel: first[0]!, whole: null },
      { channel: first[1]!, whole: [151] },
    ];
    expect(jobs.map((job) => firstSweepDone(job, first))).toEqual([
      true,
      false,
      true,
    ]);
  });

  test("初回でない全局読み (CS など) と、続きの中継ぶんは数えない", () => {
    const cs = { ...bs("CS02"), type: "CS", networkId: 6 } as AgentChannel;
    expect(firstSweepDone({ channel: cs, whole: [296] }, first)).toBe(false);
    expect(firstSweepDone({ channel: bs("BS05_0"), whole: [] }, first)).toBe(
      false,
    );
  });
});

/**
 * **並べる数をチューナーの空きに合わせる。** 実機で、ライブを見ながら「番組表をいますぐ集める」を押すと、
 * 溢れた処理が 409 で断られるたびにすぐ次のチャンネルを取って落とし、50 チャンネルのうち 4 つしか読めなかった
 */
describe("並べる数 (laneTypes)", () => {
  const tuner = (types: string[], users: number[] = [], disabled = false) => ({
    types: types as AgentChannel["type"][],
    disabled,
    rank: disabled ? null : 0,
    users: users.map((priority) => ({ use: "x", priority })),
  });
  const MLT = ["GR", "BS", "CS", "CATV"];

  test("無効なチューナーと、同じか優先度の高い利用者がいるチューナーは数えない", () => {
    const tuners = [
      tuner(["BS", "CS"]),
      tuner(["BS", "CS"], [], true),
      tuner(["BS", "CS"]),
      tuner(["BS", "CS"], [], true),
      tuner(["BS", "CS"], [], true),
      tuner(MLT, [config.priority.live]),
      tuner(MLT),
      tuner(MLT, [config.priority.logo]),
      tuner(MLT),
      tuner(MLT),
    ];
    expect(laneTypes(tuners, config.priority.epgNow)).toHaveLength(6);
  });

  test("ふだんの優先度では、衛星のロゴを待つ選局にも譲る", () => {
    expect(
      laneTypes(
        [tuner(["BS"], [config.priority.carousel]), tuner(["GR"])],
        config.priority.epg,
      ),
    ).toEqual([["GR"]]);
  });
});

/**
 * 偽のエージェント。`TunerPool.Pick` と同じく、受けられて選ぶ順 (`rank`) がいちばん小さい空きのチューナーを使う。
 * 空きが無ければ busy、`noSignal` のチューナーに入れば untuned、`preempt` の回数だけ途中で切れる
 */
function fakeAgent(
  tuners: { types: string[]; rank: number; noSignal?: boolean }[],
  preempt = new Map<string, number>(),
) {
  const held = new Set<number>();
  const log: { name: string; outcome: Outcome; last: boolean; cut: boolean }[] =
    [];
  const attempt = async (
    job: { channel: { type: string; channel: string } },
    { tune: last, cut }: Last,
  ): Promise<Outcome> => {
    const { type, channel: name } = job.channel;
    const done = (outcome: Outcome) => {
      log.push({ name, outcome, last, cut });
      return outcome;
    };
    // リクエストは非同期に届く。選んだらすぐ押さえる (`TunerPool.Open` はロックの中で利用者を入れる)
    await Bun.sleep(0);
    const index = tuners
      .map((tuner, at) => ({ ...tuner, at }))
      .filter((tuner) => tuner.types.includes(type) && !held.has(tuner.at))
      .sort((a, b) => a.rank - b.rank)[0]?.at;
    if (index === undefined) return done("busy");
    held.add(index);
    try {
      await Bun.sleep(2);
      if (tuners[index]!.noSignal) return done("untuned");
      const left = preempt.get(name) ?? 0;
      if (left > 0) {
        preempt.set(name, left - 1);
        return done("cut");
      }
      await Bun.sleep(3);
      return done("read");
    } finally {
      held.delete(index);
    }
  };
  return { attempt, log };
}

const job = (type: string, name: string) => ({
  channel: { type, channel: name },
});

describe("列を引き切る (drain)", () => {
  const MLT = ["GR", "BS", "CS", "CATV"];

  test("並べた数がチューナーより多くても、空きを待って全部読む", async () => {
    // 7 つ並べたが、エージェントが使わせるのは 4 台 (残りはライブ・録画)
    const agent = fakeAgent([
      { types: ["BS", "CS"], rank: 0 },
      { types: MLT, rank: 1 },
      { types: MLT, rank: 1 },
      { types: MLT, rank: 1 },
    ]);
    const jobs = [
      ...Array.from({ length: 12 }, (_, i) => job("GR", `T${i}`)),
      ...Array.from({ length: 6 }, (_, i) => job("BS", `BS${i}`)),
      ...Array.from({ length: 6 }, (_, i) => job("CATV", `C${i}`)),
    ];
    const dropped: unknown[] = [];
    await drain(
      [...jobs],
      [["BS", "CS"], ["BS", "CS"], MLT, MLT, MLT, MLT, MLT],
      agent.attempt,
      { backoff: 1, dropped: (gone) => dropped.push(...gone) },
    );

    const read = agent.log.filter((entry) => entry.outcome === "read");
    expect(read).toHaveLength(jobs.length);
    expect(new Set(read.map((entry) => entry.name)).size).toBe(jobs.length);
    expect(agent.log.some((entry) => entry.outcome === "busy")).toBe(true);
    expect(dropped).toEqual([]);
  });

  test("途中で切れた 1 件は列へ戻して読み直す", async () => {
    const agent = fakeAgent([{ types: MLT, rank: 0 }], new Map([["C1", 2]]));
    await drain(
      [job("CATV", "C1"), job("GR", "T1")],
      [MLT, MLT],
      agent.attempt,
      { backoff: 1 },
    );
    expect(
      agent.log
        .filter((entry) => entry.name === "C1" && entry.outcome !== "busy")
        .map((entry) => entry.outcome),
    ).toEqual(["cut", "cut", "read"]);
    expect(agent.log.filter((entry) => entry.outcome === "read")).toHaveLength(
      2,
    );
  });

  test("切れ続ける 1 件は、上限で諦める (周回が終わる)", async () => {
    const agent = fakeAgent([{ types: MLT, rank: 0 }], new Map([["C1", 100]]));
    await drain([job("CATV", "C1")], [MLT], agent.attempt, { backoff: 1 });
    // 戻さない最後の回だけ `cut` が立つ (読み終えたあとの処理をその回にする)
    expect(agent.log.map((entry) => [entry.outcome, entry.cut])).toEqual([
      ["cut", false],
      ["cut", false],
      ["cut", false],
      ["cut", true],
    ]);
  });

  /*
   * どのチューナーを使うかはエージェントが決める (docs/agent.md「選ぶ順の約束」)。電波の来ていない
   * チューナーが順位で先頭なら、空いている限りそこに入る。選局できなかった 1 件は 1 回だけ読み直し、
   * 最初の回は受信できなかったと数えない (`last` が false)
   */
  test("選局できなかった 1 件は 1 回だけ読み直し、最後の回だけ数える", async () => {
    const agent = fakeAgent([{ types: ["BS", "CS"], rank: 0, noSignal: true }]);
    await drain([job("BS", "BS1")], [["BS", "CS"]], agent.attempt, {
      backoff: 1,
    });
    expect(agent.log).toEqual([
      { name: "BS1", outcome: "untuned", last: false, cut: false },
      { name: "BS1", outcome: "untuned", last: true, cut: false },
    ]);
  });

  test("チューナーがずっと塞がっていれば、待つのを上限で打ち切って残りを落とす", async () => {
    const agent = fakeAgent([]);
    const dropped: unknown[] = [];
    await drain(
      [job("GR", "T1"), job("GR", "T2")],
      [["GR"], ["GR"]],
      agent.attempt,
      { backoff: 1, idleLimit: 3, dropped: (gone) => dropped.push(...gone) },
    );
    expect(dropped).toHaveLength(2);
    expect(agent.log.every((entry) => entry.outcome === "busy")).toBe(true);
  });
});

describe("受信できなかったと数える回 (receptionFailed)", () => {
  const none = {
    received: false,
    refused: false,
    opened: false,
    timedOut: false,
    last: true,
  };

  test("空きが無かった回と、途中で切れた回は数えない", () => {
    // 409 (開いていない)
    expect(receptionFailed(none)).toBe(false);
    // 開けたが、上限より前に切れた (優先度の高い要求に譲った)
    expect(receptionFailed({ ...none, opened: true })).toBe(false);
  });

  test("選局できなかった回は、読み直さない最後の回だけ数える", () => {
    expect(receptionFailed({ ...none, refused: true, last: false })).toBe(
      false,
    );
    expect(receptionFailed({ ...none, refused: true })).toBe(true);
  });

  test("開けたのに上限まで何も来なかった回は数える。1 バイトでも来れば数えない", () => {
    expect(receptionFailed({ ...none, opened: true, timedOut: true })).toBe(
      true,
    );
    expect(
      receptionFailed({
        ...none,
        opened: true,
        timedOut: true,
        received: true,
      }),
    ).toBe(false);
  });
});

/**
 * **番組表を読めるが復号できない局も集める** (`tuner.epgReadableChannel`)。ケーブルの 4K の局 (TLV) は MH-EIT を読む (`MmtEpgReader`)。
 * 選局の答えの形式が控えと違えば読まない (`tuner.expectTransport`)
 */
describe("番組表を読める局を集める", () => {
  const ONID_4K = 0x000b;
  const START = Math.floor((Date.now() + 60 * 60_000) / 60_000) * 60_000;
  const offered: AgentChannel[] = [
    // 4K の局。CA_system_id は B-CAS と同じ 0x0005 でも復号できない。番組表は読める
    {
      type: "CATV",
      channel: "QC26",
      networkId: ONID_4K,
      transportStreamId: 0xb111,
      remoteControlKeyId: null,
      transport: "tlv",
      services: [
        {
          serviceId: 161,
          serviceType: 1,
          name: "ＢＳでんぱ　４Ｋ",
          caSystemIds: [0x0005],
          epgReadable: true,
        },
      ],
    },
    // 控えは TLV なのに、エージェントが TS で答える (ケーブル局が搬送波の中身を入れ替えた)
    {
      type: "CATV",
      channel: "QC27",
      networkId: ONID_4K,
      transportStreamId: 0xb112,
      remoteControlKeyId: null,
      transport: "tlv",
      services: [
        {
          serviceId: 171,
          serviceType: 1,
          name: "ＢＳでんぱ　４Ｋ２",
          caSystemIds: [0x0005],
          epgReadable: true,
        },
      ],
    },
    // B-CAS 以外の方式でスクランブルされ、番組表もスクランブルされている局。集めに行かない
    {
      type: "CATV",
      channel: "QC40",
      networkId: 0xfff0,
      transportStreamId: 2,
      remoteControlKeyId: null,
      services: [
        {
          serviceId: 201,
          serviceType: 1,
          name: "ケーブル有料",
          caSystemIds: [0x0006],
          epgReadable: false,
        },
      ],
    },
  ];
  const tuner = {
    index: 0,
    name: "PX-MLT5PE",
    types: ["CATV"],
    disabled: false,
    rank: 0,
    device: "it930x:1-1:0",
    pin: "it930x:1-1:0",
    lnb: null,
    channel: null,
    users: [],
    error: null,
    signal: null,
  };
  /** QC26 の TLV。MH-EIT の予定 (基本) 1 つで揃う。最後のパケットは次のパケットの先頭が届くまで出ないので、詰め物を 1 つ足す */
  const tlv = concatBytes([
    ...signalingPackets(0x8000, [
      m2SectionMessage(
        mhEitSection({
          tableId: 0x8c,
          serviceId: 161,
          tlvStreamId: 0xb111,
          originalNetworkId: ONID_4K,
          events: [
            {
              eventId: 1,
              startAt: START,
              duration: 60 * 60_000,
              name: "🈑報道１９３０",
              description: "きょうのニュース",
              resolution: 6,
            },
          ],
        }),
      ),
    ]).map((packet) => compressedIp(1, packet)),
    tlvPacket(0xff, [0]),
  ]);

  test("4K の局の番組表を MH-EIT で読み、形式が控えと違うチャンネルと番組表を読めない局は読まない", async () => {
    const { fakeAgentUrl, serveFakeAgent } = await import("./fake-agent");
    const { orm } = await import("./db");
    const { programs, services } = await import("./schema");
    const tuned: string[] = [];
    const server = serveFakeAgent((request) => {
      const url = new URL(request.url);
      if (url.pathname === "/denpa/channels") return Response.json(offered);
      if (url.pathname === "/denpa/tuners")
        return Response.json({ tuners: [tuner], detected: false });
      if (url.pathname === "/denpa/stream") {
        const channel = url.searchParams.get("channel") ?? "";
        tuned.push(channel);
        if (channel === "QC26")
          return new Response(tlv, {
            headers: { "Content-Type": "application/x-arib-tlv" },
          });
        return new Response(new Uint8Array(188 * 8), {
          headers: { "Content-Type": "video/MP2T" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    try {
      config.agentUrl = fakeAgentUrl(server.port ?? 0);
      expect(await collectOnce()).toBe(1);
      expect(tuned.sort()).toEqual(["QC26", "QC27"]);
      expect(
        orm()
          .select({
            service_id: programs.service_id,
            name: programs.name,
            start_at: programs.start_at,
            video_resolution: programs.video_resolution,
          })
          .from(programs)
          .all(),
      ).toEqual([
        {
          service_id: serviceKey(ONID_4K, 161, "CATV"),
          name: "🈑報道１９３０",
          start_at: START,
          video_resolution: "2160p",
        },
      ]);
      // 番組表を書いた局には、集めた時刻が付く (次に行くかをこれで決める)
      const at = orm()
        .select({ id: services.id, epg_at: services.epg_at })
        .from(services)
        .all();
      expect(
        at.find((row) => row.id === serviceKey(ONID_4K, 161, "CATV"))?.epg_at,
      ).toBeNumber();
      expect(
        at.find((row) => row.id === serviceKey(ONID_4K, 171, "CATV"))?.epg_at,
      ).toBeNull();
    } finally {
      server.stop(true);
    }
  });
});
