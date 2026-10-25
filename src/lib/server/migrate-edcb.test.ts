import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MX, startFakeEdcb } from "../../../tests/fake/edcb";

/**
 * EDCB からの引き継ぎ (`migrate-edcb.ts`)。読み方 (CtrlCmd) は `edcb-ctrlcmd.test.ts`、ここは写し方と通しの取り込み。
 * 通しは偽の EpgTimerSrv (`tests/fake/edcb.ts`) に繋ぐ。番組名と局名は作り物
 */
const root = mkdtempSync(join(tmpdir(), "denpa-edcb-"));
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");

const { now, orm } = await import("./db");
const { programs, recordedHistory, rules, services } = await import("./schema");
const { status, track } = await import("./migrate");
const {
  convertRule,
  edcbTarget,
  genreOf,
  importEdcbHistory,
  importEdcbReservations,
  importEdcbRules,
  parseDateList,
  splitAndKey,
  startEdcb,
  stripNote,
} = await import("./migrate-edcb");
type EdcbRule = import("./edcb-ctrlcmd").EdcbRule;
type EdcbDate = import("./edcb-ctrlcmd").EdcbDate;
type EdcbReserve = import("./edcb-ctrlcmd").EdcbReserve;
type EdcbRecInfo = import("./edcb-ctrlcmd").EdcbRecInfo;

const fake = await startFakeEdcb();
/** 偽サーバのルールの局 (TOKYO MX) の内部ID */
const MX_ID = MX.networkId * 100000 + MX.serviceId;

const preview = { apply: false };
const apply = { apply: true };

/** でんぱ総合 (ONID 0x7FE0・TSID 0x7FE0・SID 0x0400) と BSでんぱ (ONID 4・TSID 0x4010・SID 101)。どちらも作り物 */
const GR = {
  networkId: 0x7fe0,
  transportStreamId: 0x7fe0,
  serviceId: 0x0400,
  id: 0x7fe0 * 100000 + 0x0400,
};
const BS = {
  networkId: 4,
  transportStreamId: 0x4010,
  serviceId: 101,
  id: 4 * 100000 + 101,
};
/** denpa に無い局 */
const UNKNOWN = {
  networkId: 0x7fe8,
  transportStreamId: 0x7fe8,
  serviceId: 0x0408,
};

function rule(over: Partial<EdcbRule> = {}): EdcbRule {
  return {
    id: 1,
    andKey: "",
    notKey: "",
    regExp: false,
    titleOnly: true,
    contents: [],
    dates: [],
    services: [GR],
    recMode: 1,
    aimai: false,
    notContent: false,
    notDate: false,
    freeCA: 0,
    chkRecEnd: false,
    ...over,
  };
}

/** 局は 2 つとも denpa にあるものとして引く */
const known = (networkId: number, serviceId: number) =>
  [GR, BS].find((s) => s.networkId === networkId && s.serviceId === serviceId)
    ?.id;

/** 時間帯と曜日の1件 (曜・時・分 〜 曜・時・分) */
function span(
  startDay: number,
  startHour: number,
  startMinute: number,
  endDay: number,
  endHour: number,
  endMinute: number,
): EdcbDate {
  return { startDay, startHour, startMinute, endDay, endHour, endMinute };
}

function reserveRow(
  over: Partial<EdcbReserve> & { title: string },
): EdcbReserve {
  return {
    startAt: now() + 3600_000,
    duration: 1800_000,
    networkId: GR.networkId,
    serviceId: GR.serviceId,
    eventId: 10,
    recMode: 1,
    comment: "",
    ...over,
  };
}

function recInfoRow(
  over: Partial<EdcbRecInfo> & { title: string; startAt: number },
): EdcbRecInfo {
  return {
    duration: 1800_000,
    serviceName: "でんぱ総合",
    networkId: GR.networkId,
    transportStreamId: GR.transportStreamId,
    serviceId: GR.serviceId,
    recStatus: 1,
    epgStartAt: over.startAt,
    ...over,
  };
}

function clear(): void {
  orm().delete(rules).run();
  orm().delete(recordedHistory).run();
  orm().delete(programs).run();
  orm().delete(services).run();
}

beforeEach(() => {
  clear();
  orm()
    .insert(services)
    .values([
      {
        id: GR.id,
        service_id: GR.serviceId,
        network_id: GR.networkId,
        name: "でんぱ総合",
        type: "GR",
        channel: "T27",
        updated_at: now(),
      },
      {
        id: BS.id,
        service_id: BS.serviceId,
        network_id: BS.networkId,
        name: "BSでんぱ",
        type: "BS",
        channel: "BS01_0",
        updated_at: now(),
      },
    ])
    .run();
});

/** 引き継ぎを1回走らせて、記録と件数を返す (進み具合は `track` が作り直す) */
async function within(body: () => void | Promise<void>) {
  await track("edcb", preview, async () => {
    await body();
  });
  return status();
}

describe("andKey と notKey の印", () => {
  test("無効・大小の区別・番組の長さの印を順に外す", () => {
    expect(splitAndKey("^!{999}C!{999}D!{100300060}ドラマ")).toEqual({
      disabled: true,
      caseSensitive: true,
      duration: true,
      keyword: "ドラマ",
    });
    expect(splitAndKey("ドラマ")).toEqual({
      disabled: false,
      caseSensitive: false,
      duration: false,
      keyword: "ドラマ",
    });
  });

  test("notKey のメモは最初の空白まで", () => {
    expect(stripNote(":note:朝の\\s番組 再放送 総集編")).toBe("再放送 総集編");
    expect(stripNote(":note:メモ\u3000再放送")).toBe("再放送");
    expect(stripNote(":note:メモだけ")).toBe("");
    expect(stripNote("再放送")).toBe("再放送");
  });
});

describe("ジャンル", () => {
  test("大分類だけ・中分類まで", () => {
    expect(genreOf(117440512)).toBe("7-0"); // 0x07000000
    expect(genreOf(134152192)).toBe("7"); // 0x07FF0000
  });

  test("負の数は符号なしに直してから分ける。ジャンル情報なし・拡張は写せない", () => {
    expect(genreOf(-65536)).toBeNull(); // 0xFFFF0000 = ジャンル情報なし
    expect(genreOf(0x60ff0000)).toBeNull(); // 拡張ジャンル
    expect(genreOf(-16777216)).toBeNull(); // 0xFF000000
  });
});

describe("時間帯と曜日", () => {
  test("終わりを含むので、1分後ろにする", () => {
    // 月曜 20:00〜21:30
    expect(parseDateList([span(1, 20, 0, 1, 21, 30)])).toEqual({
      slot: { time_from: 20 * 60, time_to: 21 * 60 + 31, weekdays: [1] },
      widened: false,
    });
  });

  test("23:59 まではその日の終わりまで、0:00〜23:59 は丸一日", () => {
    expect(parseDateList([span(5, 22, 0, 5, 23, 59)])).toEqual({
      slot: { time_from: 22 * 60, time_to: 0, weekdays: [5] },
      widened: false,
    });
    expect(
      parseDateList([span(0, 0, 0, 0, 23, 59), span(6, 0, 0, 6, 23, 59)]),
    ).toEqual({
      slot: { time_from: null, time_to: null, weekdays: [0, 6] },
      widened: false,
    });
  });

  test("時刻の同じものは曜日をまとめる", () => {
    const days = [1, 2, 3, 4, 5].map((day) => span(day, 19, 0, day, 19, 59));
    expect(parseDateList(days)).toEqual({
      slot: { time_from: 19 * 60, time_to: 20 * 60, weekdays: [1, 2, 3, 4, 5] },
      widened: false,
    });
  });

  test("日をまたぐものは次の日の曜日も足し、そう記す", () => {
    // 月・火の 23:00〜翌 1:00 (EpgTimer の「曜日ごと」の書き方)
    expect(
      parseDateList([span(1, 23, 0, 2, 1, 0), span(2, 23, 0, 3, 1, 0)]),
    ).toEqual({
      slot: { time_from: 23 * 60, time_to: 61, weekdays: [1, 2, 3] },
      widened: true,
    });
    // 7日そろえば EDCB と同じ
    const all = [0, 1, 2, 3, 4, 5, 6].map((day) =>
      span(day, 23, 0, (day + 1) % 7, 1, 0),
    );
    expect(parseDateList(all)).toEqual({
      slot: { time_from: 23 * 60, time_to: 61, weekdays: null },
      widened: false,
    });
  });

  test("時刻の違う時間帯が2つ、2日以上にわたる途中からの時間帯は写せない", () => {
    expect(
      parseDateList([span(1, 19, 0, 1, 20, 0), span(2, 21, 0, 2, 22, 0)]),
    ).toEqual({ skip: "時刻の違う時間帯が2つ以上あるので取り込めません" });
    expect(parseDateList([span(1, 20, 0, 3, 21, 0)])).toHaveProperty("skip");
    // 日 0:00〜土 23:59 は毎日
    expect(parseDateList([span(0, 0, 0, 6, 23, 59)])).toEqual({
      slot: { time_from: null, time_to: null, weekdays: null },
      widened: false,
    });
  });

  test("空ならいつでも", () => {
    expect(parseDateList([])).toEqual({
      slot: { time_from: null, time_to: null, weekdays: null },
      widened: false,
    });
  });
});

describe("ルールに写す", () => {
  test("キーワード・除外・範囲・局・ジャンル・時間帯・重複の確認", () => {
    const converted = convertRule(
      rule({
        andKey: "テスト　番組",
        notKey: ":note:メモ 再放送 総集編",
        titleOnly: false,
        services: [GR, BS],
        contents: [134152192, 117440512],
        dates: [span(6, 9, 0, 6, 9, 29)],
        chkRecEnd: true,
      }),
      known,
    );
    expect(converted).toEqual({
      values: {
        name: "テスト 番組",
        keyword: "テスト 番組",
        ignore_keyword: "再放送 総集編",
        search_fields: "name,description,extended",
        service_ids: [GR.id, BS.id],
        genres: ["7", "7-0"],
        time_from: 9 * 60,
        time_to: 9 * 60 + 30,
        weekdays: [6],
        enabled: true,
        dedupe: true,
      },
      notes: [],
    });
  });

  test("キーワードが無ければ名前は EDCB #<ID>。局だけのルールもそのまま入る", () => {
    const converted = convertRule(rule({ id: 42 }), known);
    expect(converted).toMatchObject({
      values: { name: "EDCB #42", keyword: "", service_ids: [GR.id] },
    });
  });

  test("無効の印と、録画しない録画モードは無効にする", () => {
    expect(convertRule(rule({ andKey: "^!{999}テスト" }), known)).toMatchObject(
      { values: { enabled: false, keyword: "テスト" }, notes: [] },
    );
    for (const recMode of [4, 5, 9])
      expect(
        convertRule(rule({ andKey: "テスト", recMode }), known),
      ).toMatchObject({
        values: { enabled: false },
        notes: ["録画しないルールなので無効にして取り込みました"],
      });
  });

  test("あいまい検索と大小の区別は普通の検索として入れ、記す", () => {
    expect(
      convertRule(rule({ andKey: "C!{999}Test", aimai: true }), known),
    ).toMatchObject({
      values: { keyword: "Test", enabled: true },
      notes: [
        "あいまい検索は普通の検索として取り込みました",
        "大文字と小文字の区別は普通の検索として取り込みました",
      ],
    });
  });

  test("写せないものは飛ばす", () => {
    const skip = (over: Partial<EdcbRule>) =>
      (
        convertRule(rule({ andKey: "テスト", ...over }), known) as {
          skip?: string;
        }
      ).skip;
    expect(skip({ regExp: true })).toContain("正規表現");
    expect(skip({ andKey: "D!{100300060}テスト" })).toContain("番組の長さ");
    expect(skip({ andKey: "テスト | 番組" })).toContain("OR");
    expect(skip({ andKey: ":title:テスト" })).toContain("語ごと");
    expect(skip({ notKey: "::再.*" })).toContain("語ごと");
    expect(skip({ contents: [117440512], notContent: true })).toContain(
      "ジャンルの NOT",
    );
    expect(skip({ dates: [span(1, 1, 0, 1, 2, 0)], notDate: true })).toContain(
      "時間帯の NOT",
    );
    expect(skip({ freeCA: 2 })).toContain("有料放送だけ");
    expect(skip({ contents: [-65536] })).toContain("ジャンル");
    // NOT の印があっても、条件が空なら EDCB も絞らない
    expect(skip({ notContent: true, notDate: true })).toBeUndefined();
  });

  test("局が空のルールは全局にしないで飛ばす", () => {
    expect(
      convertRule(rule({ andKey: "テスト", services: [] }), known),
    ).toEqual({
      skip: "局が空なので取り込めません (EDCB では何にも当たらない)",
    });
  });

  test("見つからない局は外し、1つも残らなければ飛ばす", () => {
    expect(
      convertRule(rule({ andKey: "テスト", services: [GR, UNKNOWN] }), known),
    ).toMatchObject({
      values: { service_ids: [GR.id] },
      notes: ["見つからない局を外しました (32744-1032)"],
    });
    expect(
      convertRule(rule({ andKey: "テスト", services: [UNKNOWN] }), known),
    ).toEqual({ skip: "局が1つも見つからないので取り込めません" });
  });
});

describe("取り込み", () => {
  test("ルールは下見で数え、取り込みで入れる。もう一度回しても重ならない", async () => {
    const list = [
      rule({ id: 1, andKey: "テスト番組" }),
      rule({ id: 2, andKey: "テスト", regExp: true }),
      rule({ id: 3, andKey: "テスト", services: [] }),
    ];
    const first = await within(() => importEdcbRules(list, preview));
    expect(first.rules).toEqual({ imported: 1, skipped: 2 });
    expect(first.log).toContain("ルール(予定): テスト番組");
    expect(first.log).toContain("正規表現のルールは取り込めません: #2 テスト");
    expect(orm().select().from(rules).all()).toEqual([]);

    await within(() => importEdcbRules(list, apply));
    const [inserted, ...others] = orm().select().from(rules).all();
    expect(others).toEqual([]);
    expect(inserted).toMatchObject({
      name: "テスト番組",
      source: "edcb:1",
      priority: 1,
      service_ids: [GR.id],
      service_types: null,
    });

    const again = await within(() => importEdcbRules(list, apply));
    expect(again.rules).toEqual({ imported: 0, skipped: 3 });
    expect(orm().select().from(rules).all()).toHaveLength(1);
  });

  test("予約は手で入れたものだけ。過去・録画しない・時刻だけ・番組表に無いものは飛ばす", async () => {
    const soon = now() + 3600_000;
    const eventOf = (eventId: number) => GR.id * 100000 + eventId;
    orm()
      .insert(programs)
      .values([
        {
          id: eventOf(10),
          service_id: GR.serviceId,
          network_id: GR.networkId,
          event_id: 10,
          start_at: soon,
          end_at: soon + 1800_000,
          name: "テスト番組",
          updated_at: now(),
        },
        {
          id: eventOf(11),
          service_id: GR.serviceId,
          network_id: GR.networkId,
          event_id: 11,
          start_at: soon,
          end_at: soon + 1800_000,
          name: "コピー禁止の番組",
          copy_never: true,
          updated_at: now(),
        },
      ])
      .run();
    const list = [
      reserveRow({ startAt: soon, title: "テスト番組", eventId: 10 }),
      reserveRow({
        startAt: soon,
        title: "ルールの番組",
        eventId: 12,
        comment: "EPG自動予約(テスト)",
      }),
      reserveRow({
        startAt: now() - 7200_000,
        title: "終わった番組",
        eventId: 13,
      }),
      reserveRow({
        startAt: soon,
        title: "無効の番組",
        eventId: 14,
        recMode: 5,
      }),
      reserveRow({ startAt: soon, title: "時刻だけ", eventId: 0xffff }),
      reserveRow({ startAt: soon, title: "番組表に無い番組", eventId: 15 }),
      reserveRow({ startAt: soon, title: "コピー禁止の番組", eventId: 11 }),
    ];
    const result = await within(() => importEdcbReservations(list, preview));
    expect(result.reservations).toEqual({ imported: 2, skipped: 4 });
    expect(result.log).toEqual(
      expect.arrayContaining([
        "ルールが作った予約 1 件は、ルールから作り直すので飛ばします",
        "予約(予定): テスト番組",
        "録画しない予約は取り込めません: 無効の番組",
        "番組に結び付かない予約 (時刻だけの予約) は取り込めません: 時刻だけ",
        "番組表に無いので取り込めません: 番組表に無い番組",
      ]),
    );

    // 予約できないもの (コピー禁止) は記録に残して先へ進む
    const applied = await within(() =>
      importEdcbReservations(
        list.filter((row) => row.title === "コピー禁止の番組"),
        apply,
      ),
    );
    expect(applied.state).toBe("done");
    expect(applied.reservations).toEqual({ imported: 0, skipped: 1 });
    expect(applied.log.join("\n")).toContain(
      "予約できません: コピー禁止の番組",
    );
  });

  test("録画の履歴は正しく録れたものだけ。鍵は局と EPG の開始で、もう一度回しても重ならない", async () => {
    const start = Date.UTC(2026, 8, 1, 12, 0, 0);
    const list = [
      // 録画が 1 分前から (マージン)。鍵は予約したときの番組の開始
      recInfoRow({
        title: "テスト番組 #1",
        startAt: start - 60_000,
        epgStartAt: start,
      }),
      // EPG の開始が無ければ録画の開始で
      recInfoRow({
        title: "テスト番組 #0",
        startAt: start - 7 * 86400_000,
        epgStartAt: null,
      }),
      // 録れなかったものは入れない
      recInfoRow({
        title: "失敗した番組",
        startAt: start + 86400_000,
        recStatus: 2,
      }),
    ];
    const first = await within(() => importEdcbHistory(list, apply));
    expect(first.history).toEqual({ imported: 2, skipped: 0 });
    const rows = orm()
      .select()
      .from(recordedHistory)
      .orderBy(recordedHistory.end_at)
      .all();
    expect(
      rows.map(({ name, service_name, end_at, source }) => ({
        name,
        service_name,
        end_at,
        source,
      })),
    ).toEqual([
      {
        name: "テスト番組 #0",
        service_name: "でんぱ総合",
        end_at: start - 7 * 86400_000 + 1800_000,
        source: `edcb:recinfo:32736-32736-1024-${start - 7 * 86400_000}`,
      },
      {
        name: "テスト番組 #1",
        service_name: "でんぱ総合",
        // 録画の開始 + 長さ
        end_at: start - 60_000 + 1800_000,
        source: `edcb:recinfo:32736-32736-1024-${start}`,
      },
    ]);

    const again = await within(() => importEdcbHistory(list, apply));
    expect(again.history).toEqual({ imported: 0, skipped: 2 });
    expect(orm().select().from(recordedHistory).all()).toHaveLength(2);
  });

  test("同じ局・同じ開始の行が2つあっても、下見と取り込みで件数がそろう", async () => {
    const start = Date.UTC(2026, 8, 1, 12, 0, 0);
    const list = [
      recInfoRow({ title: "テスト番組 #1", startAt: start }),
      recInfoRow({ title: "テスト番組 #1", startAt: start }),
    ];
    const previewed = await within(() => importEdcbHistory(list, preview));
    const applied = await within(() => importEdcbHistory(list, apply));
    expect(previewed.history).toEqual({ imported: 1, skipped: 0 });
    expect(applied.history).toEqual(previewed.history);
    expect(orm().select().from(recordedHistory).all()).toHaveLength(1);
  });
});

describe("EpgTimerSrv から通しで", () => {
  afterAll(() => fake.stop());

  /** 走り出した引き継ぎが終わるまで待つ */
  async function settled() {
    const until = Date.now() + 10_000;
    while (status().state === "running" && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return status();
  }

  beforeEach(() => {
    fake.setMode({});
    // 偽サーバのルールの局 (TOKYO MX) を denpa の局に足す
    orm()
      .insert(services)
      .values({
        id: MX_ID,
        service_id: MX.serviceId,
        network_id: MX.networkId,
        name: "ＴＯＫＹＯ　ＭＸ１",
        type: "GR",
        channel: "16",
        updated_at: now(),
      })
      .run();
  });

  test("下見 → 取り込み。もう一度回しても増えない", async () => {
    const previewed = await startEdcb(` ${fake.target} `, preview);
    expect(previewed).toEqual({ started: true, message: "下見を開始しました" });
    expect(edcbTarget()).toBe(fake.target);
    const first = await settled();
    expect(first.state).toBe("done");
    expect(first.from).toBe("edcb");
    expect(first.rules).toEqual({ imported: 1, skipped: 1 });
    expect(first.history).toEqual({ imported: 1, skipped: 0 });
    expect(first.reservations).toEqual({ imported: 0, skipped: 0 });
    expect(first.log).toContain(
      `EpgTimerSrv (${fake.target}): 録画済み 1 件・ルール 2 件・予約 1 件`,
    );
    expect(orm().select().from(rules).all()).toEqual([]);

    await startEdcb(fake.target, apply);
    const applied = await settled();
    expect(applied.rules).toEqual({ imported: 1, skipped: 1 });
    expect(orm().select().from(rules).get()).toMatchObject({
      name: "引き継ぎテスト",
      enabled: false,
      source: "edcb:1",
    });

    await startEdcb(fake.target, apply);
    const again = await settled();
    expect(again.rules).toEqual({ imported: 0, skipped: 2 });
    expect(again.history).toEqual({ imported: 0, skipped: 1 });
    expect(orm().select().from(rules).all()).toHaveLength(1);
    expect(orm().select().from(recordedHistory).all()).toHaveLength(1);
  });

  test("前に設定フォルダのファイルから取り込んだルールと履歴 (同じ source) は飛ぶ", async () => {
    const start = Date.UTC(2026, 8, 1, 12, 0, 0);
    orm()
      .insert(rules)
      .values({
        name: "前に取り込んだルール",
        keyword: "引き継ぎテスト",
        service_ids: [MX_ID],
        priority: 1,
        source: "edcb:1",
        created_at: now(),
      })
      .run();
    orm()
      .insert(recordedHistory)
      .values({
        name: "引き継ぎテスト #1",
        service_name: "ＴＯＫＹＯ　ＭＸ１",
        end_at: start,
        source: `edcb:recinfo2:${MX.networkId}-${MX.transportStreamId}-${MX.serviceId}-${start}`,
      })
      .run();
    await startEdcb(fake.target, apply);
    const result = await settled();
    expect(result.rules).toEqual({ imported: 0, skipped: 2 });
    expect(result.history).toEqual({ imported: 0, skipped: 1 });
    expect(orm().select().from(rules).all()).toHaveLength(1);
    expect(orm().select().from(recordedHistory).all()).toHaveLength(1);
  });

  test("ver が違えば記録に1回だけ残して続ける", async () => {
    fake.setMode({ ver: 4 });
    await startEdcb(fake.target, preview);
    const result = await settled();
    expect(result.state).toBe("done");
    expect(
      result.log.filter((line) => line.includes("バージョンが 4 です")),
    ).toHaveLength(1);
  });

  test("繋がらなければ始めず、その場で理由を返す", async () => {
    fake.setMode({ deny: true });
    const result = await startEdcb(fake.target, preview);
    expect(result.started).toBe(false);
    expect(result.message).toContain("アクセス制御");
    expect(await startEdcb("  ", preview)).toEqual({
      started: false,
      message: "EpgTimerSrv の宛先を入れてください (例: 192.168.1.10:4510)",
    });
    expect((await startEdcb("tcp://edcb:4510", preview)).message).toContain(
      "host:port",
    );
  });
});
