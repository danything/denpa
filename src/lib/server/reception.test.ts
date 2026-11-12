import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 受信できるかの記録。失敗は番組表の取得が残し、受信できたことは誰の選局でも残す (確かめるための選局は増やさない)。
 * 時刻は渡して進める (1 時間の数え直し・ほかのチャンネルが受信できた時刻を作るため)
 */
const { config } = await import("./config");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-reception-")),
  "denpa.db",
);

const { orm } = await import("./db");
const { agentChannels, channelReception } = await import("./schema");
const {
  checkedAt,
  pruneReception,
  receptionOf,
  recordFailed,
  recordReceived,
  RECOUNT_AFTER,
  unreceivableChannels,
} = await import("./reception");

const HOUR = 60 * 60_000;
const T0 = 1_800_000_000_000;
/** 選局を送ったエージェント (`agents.id`)。行が無くても記録は書ける */
const A = 1;

beforeEach(() => {
  orm().delete(channelReception).run();
  // エージェントの控えの写しも前のテストのものを残さない (ほかのエージェントで受信できることになる)
  orm().delete(agentChannels).run();
});

describe("受信できないと決める", () => {
  test("2 回続けて受信できず、その間にほかのチャンネルが受信できていれば決める", () => {
    recordReceived(A, "BS", "BS01:16400", T0);
    expect(recordFailed(A, "BS", "BS03:16432", T0 + HOUR)).toBe(false);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    // 2 回目で決まる。決まった回だけ true (呼ぶ側が一度だけ記録に残す)
    expect(recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR)).toBe(true);
    expect(recordFailed(A, "BS", "BS03:16432", T0 + 5 * HOUR)).toBe(false);
    expect(unreceivableChannels(A)).toEqual(new Set(["BS:BS03:16432"]));
  });

  test("1 回の失敗では決めない (一時的な受信の不調)", () => {
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    expect(unreceivableChannels(A).size).toBe(0);
  });

  test("同じ周回の失敗は 1 回と数える", () => {
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS01:16400", T0 + HOUR + 1);
    expect(
      recordFailed(A, "BS", "BS03:16432", T0 + HOUR + RECOUNT_AFTER - 1),
    ).toBe(false);
    expect(unreceivableChannels(A).size).toBe(0);
  });

  test("その種別がどれも受信できなくなったら決めない (アンテナかチューナーの問題)", () => {
    // 受信できなくなる前に受信できていても、受信できなくなってからは 1 つも受信できていない
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordFailed(A, "BS", "BS01:16400", T0 + HOUR + 1);
    recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR);
    recordFailed(A, "BS", "BS01:16400", T0 + 3 * HOUR + 1);
    expect(unreceivableChannels(A).size).toBe(0);
  });

  test("地上波は決めない (スキャンで受信できたものだけが入っている。知らせるだけ)", () => {
    recordReceived(A, "GR", "T16", T0);
    recordFailed(A, "GR", "T27", T0 + HOUR);
    recordReceived(A, "GR", "T16", T0 + 2 * HOUR);
    expect(recordFailed(A, "GR", "T27", T0 + 3 * HOUR)).toBe(false);
    expect(unreceivableChannels(A).size).toBe(0);
  });

  test("ほかの種別が受信できても決めない", () => {
    recordReceived(A, "GR", "T27", T0 + 2 * HOUR);
    recordFailed(A, "CS", "CS02:24608", T0 + HOUR);
    recordFailed(A, "CS", "CS02:24608", T0 + 3 * HOUR);
    expect(unreceivableChannels(A).size).toBe(0);
  });

  test("受信できたら印を消し、数え直す", () => {
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR);
    recordReceived(A, "BS", "BS03:16432", T0 + 4 * HOUR);
    expect(unreceivableChannels(A).size).toBe(0);
    // また 1 回だけ失敗しても、すぐには決めない
    expect(recordFailed(A, "BS", "BS03:16432", T0 + 6 * HOUR)).toBe(false);
  });

  test("受信できたあとの失敗は、前の失敗から 1 時間たっていなくても 1 回と数える", () => {
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS03:16432", T0 + HOUR + 10 * 60_000);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR + 20 * 60_000);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    expect(recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR)).toBe(true);
  });
});

describe("設定に出す受信の様子", () => {
  test("確かめていない衛星は確認中、地上波は受信できる、決めたものは受信できない", () => {
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR);
    const state = receptionOf([
      { agent: A, type: "GR", channel: "T27" },
      { agent: A, type: "BS", channel: "BS01:16400" },
      { agent: A, type: "BS", channel: "BS03:16432" },
      { agent: A, type: "CS", channel: "CS02:24608" },
      // SKY はスキャンで受信できたものだけが入り、番組表の取得では確かめない
      { agent: A, type: "SKY", channel: "H40" },
    ]);
    expect([...state.values()]).toEqual([
      "ok",
      "ok",
      "unreceivable",
      "checking",
      "ok",
    ]);
  });

  test("控えから消えたチャンネルの記録は捨てる。空の一覧では捨てない", () => {
    recordReceived(A, "BS", "BS01:16400", T0);
    recordReceived(A, "BS", "BS03:16432", T0);
    pruneReception(A, []);
    expect(orm().select().from(channelReception).all()).toHaveLength(2);
    pruneReception(A, [{ type: "BS", channel: "BS01:16400" }]);
    expect(
      orm()
        .select()
        .from(channelReception)
        .all()
        .map((row) => row.channel),
    ).toEqual(["BS01:16400"]);
  });
});

describe("受信できないチャンネルの局", () => {
  test("番組表・ライブに出る局 (いまの局) に入れない", async () => {
    const { currentServices, syncServices } = await import("./epg");
    const { services } = await import("./schema");
    const entry = (channel: string, serviceId: number) => ({
      type: "BS" as const,
      channel,
      networkId: 4,
      transportStreamId: Number(channel.split(":")[1]),
      remoteControlKeyId: null,
      services: [{ serviceId, serviceType: 1, name: `局${serviceId}` }],
    });
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR);

    syncServices([
      {
        agent: A,
        channels: [entry("BS01:16400", 151), entry("BS03:16432", 191)],
      },
    ]);
    const listed = orm()
      .select({ id: services.id })
      .from(services)
      .where(currentServices())
      .all()
      .map((row) => row.id);
    expect(listed).toContain(400151);
    expect(listed).not.toContain(400191);
  });

  test("外すのは、その局を受けられる全部のエージェントで受信できないときだけ", async () => {
    const { currentServices, syncServices } = await import("./epg");
    const { services } = await import("./schema");
    const B = 2;
    const entry = (channel: string, serviceId: number) => ({
      type: "BS" as const,
      channel,
      networkId: 4,
      transportStreamId: Number(channel.split(":")[1]),
      remoteControlKeyId: null,
      services: [{ serviceId, serviceType: 1, name: `局${serviceId}` }],
    });
    const both = [entry("BS01:16400", 151), entry("BS03:16432", 191)];
    // A では BS03 を受信できないと決め、B では受信できている
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR);
    recordReceived(B, "BS", "BS03:16432", T0 + 3 * HOUR);
    const listed = () =>
      orm()
        .select({ id: services.id })
        .from(services)
        .where(currentServices())
        .all()
        .map((row) => row.id);

    syncServices([
      { agent: A, channels: both },
      { agent: B, channels: both },
    ]);
    expect(listed()).toContain(400191);

    // B でも受信できないと決めたら外す
    recordReceived(B, "BS", "BS01:16400", T0 + 4 * HOUR);
    recordFailed(B, "BS", "BS03:16432", T0 + 5 * HOUR);
    recordReceived(B, "BS", "BS01:16400", T0 + 6 * HOUR);
    recordFailed(B, "BS", "BS03:16432", T0 + 7 * HOUR);
    syncServices([
      { agent: A, channels: both },
      { agent: B, channels: both },
    ]);
    expect(listed()).not.toContain(400191);
  });

  test("受信の記録はエージェントごと。ほかのエージェントで受信できても、印は消えない", () => {
    const B = 2;
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR);
    recordReceived(B, "BS", "BS03:16432", T0 + 4 * HOUR);
    expect(unreceivableChannels(A)).toEqual(new Set(["BS:BS03:16432"]));
    expect(unreceivableChannels(B).size).toBe(0);
  });

  test("ほかのチャンネルが受信できたかは、同じエージェントの中で見る", () => {
    const B = 2;
    // B で BS01 を受信できていても、A の BS03 は受信できないと決めない (A のアンテナの問題かもしれない)
    recordReceived(B, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(B, "BS", "BS01:16400", T0 + 2 * HOUR);
    expect(recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR)).toBe(false);
  });
});

describe("受信できないチャンネルの局の番組表", () => {
  test("ほかの中継器から届いても入れない。受信できれば入れる", async () => {
    const { savePrograms } = await import("./epg");
    const event = (serviceId: number) =>
      ({
        serviceId,
        transportStreamId: 16432,
        originalNetworkId: 4,
        eventId: 7,
        // 番組の時刻はいまに近くないと取り込まない (`epg.timed`)
        startAt: Date.now() + HOUR,
        duration: 1800_000,
        isFree: true,
        runningStatus: 0,
        name: "番組",
        description: "",
        extended: {},
        genres: [],
        audios: [],
        video: null,
        copyNever: false,
      }) as Parameters<typeof savePrograms>[0][number];
    // 受信できるうちに局の行を入れておく
    const { syncServices } = await import("./epg");
    syncServices([
      {
        agent: A,
        channels: [
          {
            type: "BS",
            channel: "BS03:16432",
            networkId: 4,
            transportStreamId: 16432,
            remoteControlKeyId: null,
            services: [{ serviceId: 191, serviceType: 1, name: "局191" }],
          },
        ],
      },
    ]);
    expect(savePrograms([event(191)], { type: "BS" })).toBe(1);
    recordReceived(A, "BS", "BS01:16400", T0);
    recordFailed(A, "BS", "BS03:16432", T0 + HOUR);
    recordReceived(A, "BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed(A, "BS", "BS03:16432", T0 + 3 * HOUR);
    expect(savePrograms([event(191)], { type: "BS" })).toBe(0);
    recordReceived(A, "BS", "BS03:16432", T0 + 4 * HOUR);
    expect(savePrograms([event(191)], { type: "BS" })).toBe(1);
  });
});

describe("最後に確かめた時刻", () => {
  test("受信できた・できなかったの新しいほう。確かめていないチャンネルは入らない", () => {
    recordReceived(A, "CS", "CS02:24608", T0);
    recordFailed(A, "CS", "CS02:24608", T0 + HOUR);
    recordFailed(A, "CS", "CS08:24704", T0);
    recordReceived(A, "CS", "CS08:24704", T0 + 2 * HOUR);

    const checked = checkedAt(A);
    expect(checked.get("CS:CS02:24608")).toBe(T0 + HOUR);
    expect(checked.get("CS:CS08:24704")).toBe(T0 + 2 * HOUR);
    expect(checked.has("CS:CS10:24736")).toBe(false);
  });
});
