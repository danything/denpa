import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 受信できるかの記録。番組表集めが中継器を開いたときの成否だけで決める (選局は増やさない)。
 * 時刻は渡して進める (1 時間の数え直し・ほかのチャンネルが受信できた時刻を作るため)
 */
const { config } = await import("./config");
config.dbPath = join(
  mkdtempSync(join(tmpdir(), "denpa-reception-")),
  "denpa.db",
);

const { orm } = await import("./db");
const { channelReception } = await import("./schema");
const {
  pruneReception,
  receptionOf,
  recordFailed,
  recordReceived,
  RECOUNT_AFTER,
  unreceivableChannels,
} = await import("./reception");

const HOUR = 60 * 60_000;
const T0 = 1_800_000_000_000;

beforeEach(() => {
  orm().delete(channelReception).run();
});

describe("受信できないと決める", () => {
  test("2 回続けて受信できず、その間にほかのチャンネルが受信できていれば決める", () => {
    recordReceived("BS", "BS01:16400", T0);
    expect(recordFailed("BS", "BS03:16432", T0 + HOUR)).toBe(false);
    recordReceived("BS", "BS01:16400", T0 + 2 * HOUR);
    // 2 回目で決まる。決まった回だけ true (呼ぶ側が一度だけ記録に残す)
    expect(recordFailed("BS", "BS03:16432", T0 + 3 * HOUR)).toBe(true);
    expect(recordFailed("BS", "BS03:16432", T0 + 5 * HOUR)).toBe(false);
    expect(unreceivableChannels()).toEqual(new Set(["BS:BS03:16432"]));
  });

  test("1 回の失敗では決めない (一時的な受信の不調)", () => {
    recordReceived("BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed("BS", "BS03:16432", T0 + HOUR);
    expect(unreceivableChannels().size).toBe(0);
  });

  test("同じ周回の失敗は 1 回と数える", () => {
    recordReceived("BS", "BS01:16400", T0);
    recordFailed("BS", "BS03:16432", T0 + HOUR);
    recordReceived("BS", "BS01:16400", T0 + HOUR + 1);
    expect(
      recordFailed("BS", "BS03:16432", T0 + HOUR + RECOUNT_AFTER - 1),
    ).toBe(false);
    expect(unreceivableChannels().size).toBe(0);
  });

  test("その種別がどれも受信できなくなったら決めない (アンテナかチューナーの問題)", () => {
    // 受信できなくなる前に受信できていても、受信できなくなってからは 1 つも受信できていない
    recordReceived("BS", "BS01:16400", T0);
    recordFailed("BS", "BS03:16432", T0 + HOUR);
    recordFailed("BS", "BS01:16400", T0 + HOUR + 1);
    recordFailed("BS", "BS03:16432", T0 + 3 * HOUR);
    recordFailed("BS", "BS01:16400", T0 + 3 * HOUR + 1);
    expect(unreceivableChannels().size).toBe(0);
  });

  test("地上波は決めない (スキャンで受信できたものだけが入っている。知らせるだけ)", () => {
    recordReceived("GR", "T16", T0);
    recordFailed("GR", "T27", T0 + HOUR);
    recordReceived("GR", "T16", T0 + 2 * HOUR);
    expect(recordFailed("GR", "T27", T0 + 3 * HOUR)).toBe(false);
    expect(unreceivableChannels().size).toBe(0);
  });

  test("ほかの種別が受信できても決めない", () => {
    recordReceived("GR", "T27", T0 + 2 * HOUR);
    recordFailed("CS", "CS02:24608", T0 + HOUR);
    recordFailed("CS", "CS02:24608", T0 + 3 * HOUR);
    expect(unreceivableChannels().size).toBe(0);
  });

  test("受信できたら印を消し、数え直す", () => {
    recordReceived("BS", "BS01:16400", T0);
    recordFailed("BS", "BS03:16432", T0 + HOUR);
    recordReceived("BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed("BS", "BS03:16432", T0 + 3 * HOUR);
    recordReceived("BS", "BS03:16432", T0 + 4 * HOUR);
    expect(unreceivableChannels().size).toBe(0);
    // また 1 回だけ失敗しても、すぐには決めない
    expect(recordFailed("BS", "BS03:16432", T0 + 6 * HOUR)).toBe(false);
  });
});

describe("設定に出す受信の様子", () => {
  test("確かめていない衛星は確認中、地上波は受信できる、決めたものは受信できない", () => {
    recordReceived("BS", "BS01:16400", T0);
    recordFailed("BS", "BS03:16432", T0 + HOUR);
    recordReceived("BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed("BS", "BS03:16432", T0 + 3 * HOUR);
    const state = receptionOf([
      { type: "GR", channel: "T27" },
      { type: "BS", channel: "BS01:16400" },
      { type: "BS", channel: "BS03:16432" },
      { type: "CS", channel: "CS02:24608" },
    ]);
    expect([...state.values()]).toEqual([
      "ok",
      "ok",
      "unreceivable",
      "checking",
    ]);
  });

  test("控えから消えたチャンネルの記録は捨てる。空の一覧では捨てない", () => {
    recordReceived("BS", "BS01:16400", T0);
    recordReceived("BS", "BS03:16432", T0);
    pruneReception([]);
    expect(orm().select().from(channelReception).all()).toHaveLength(2);
    pruneReception([{ type: "BS", channel: "BS01:16400" }]);
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
    recordReceived("BS", "BS01:16400", T0);
    recordFailed("BS", "BS03:16432", T0 + HOUR);
    recordReceived("BS", "BS01:16400", T0 + 2 * HOUR);
    recordFailed("BS", "BS03:16432", T0 + 3 * HOUR);

    syncServices([entry("BS01:16400", 151), entry("BS03:16432", 191)]);
    const listed = orm()
      .select({ id: services.id })
      .from(services)
      .where(currentServices())
      .all()
      .map((row) => row.id);
    expect(listed).toContain(400151);
    expect(listed).not.toContain(400191);
  });
});
