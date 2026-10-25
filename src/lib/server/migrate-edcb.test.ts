import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * EDCB からの引き継ぎ (`migrate-edcb.ts`)。
 *
 * EDCB の実物のファイルは使わない。形式 (EDCB の `ParseTextInstances.cpp` の書き出し方) どおりに
 * ここで作る。番組名と局名は作り物
 */
const root = mkdtempSync(join(tmpdir(), "denpa-edcb-"));
const { config } = await import("./config");
config.dbPath = join(root, "denpa.db");

const { now, orm } = await import("./db");
const { programs, recordedHistory, rules, services } = await import("./schema");
const { status, track } = await import("./migrate");
const {
  convertRule,
  decodeText,
  genreOf,
  importEdcbHistory,
  importEdcbReservations,
  importEdcbRules,
  jstAt,
  parseAutoAdd,
  parseDateList,
  parseRecInfo,
  parseRecInfo2,
  parseReserve,
  rowsOf,
  runEdcb,
  settingFiles,
  splitAndKey,
  stripNote,
} = await import("./migrate-edcb");
type EdcbRule = import("./migrate-edcb").EdcbRule;

const preview = { apply: false };
const apply = { apply: true };

/** でんぱ総合 (ONID 0x7FE0・TSID 0x7FE0・SID 0x0400) と BSでんぱ (ONID 4・TSID 0x4010・SID 101)。どちらも作り物 */
const GR = {
  networkId: 0x7fe0,
  serviceId: 0x0400,
  id: 0x7fe0 * 100000 + 0x0400,
};
const BS = { networkId: 4, serviceId: 101, id: 4 * 100000 + 101 };
const GR_HEX = "7FE07FE00400";
const BS_HEX = "000440100065";

/** UTF-8 の BOM */
const BOM = "\ufeff";

/**
 * CP932 で書く。`TextDecoder("shift_jis")` の表を逆に引いて作る (試すのは読み取りのほうなので、
 * 表そのものが正しいかは下の「テスト」のバイト列で別に確かめる)
 */
const SJIS = (() => {
  const decoder = new TextDecoder("shift_jis");
  const table = new Map<string, number[]>();
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const char = decoder.decode(new Uint8Array([lead, trail]));
      if (char.length === 1 && char !== "\ufffd" && !table.has(char))
        table.set(char, [lead, trail]);
    }
  }
  return (text: string) =>
    new Uint8Array(
      [...text].flatMap((char) => {
        const code = char.charCodeAt(0);
        if (code < 0x80) return [code];
        const bytes = table.get(char);
        if (bytes === undefined) throw new Error(`CP932 に無い字: ${char}`);
        return bytes;
      }),
    );
})();

/** `EpgAutoAdd.txt` の1行。録画フォルダ1つ・部分受信用フォルダ無しで、最後に空の列が付く (EDCB の書き方) */
function autoAddLine(over: Partial<Record<string, string | number>> = {}) {
  const r = {
    id: 1,
    andKey: "",
    notKey: "",
    regExp: 0,
    titleOnly: 1,
    contents: "",
    dates: "",
    services: GR_HEX,
    recMode: 1,
    aimai: 0,
    notContent: 0,
    notDate: 0,
    freeCA: 0,
    chkRecEnd: 0,
    chkRecDay: 6,
    ...over,
  };
  return [
    r.id,
    r.andKey,
    r.notKey,
    r.regExp,
    r.titleOnly,
    r.contents,
    r.dates,
    r.services,
    r.recMode,
    2, // priority
    1, // tuijyuuFlag
    0, // serviceMode
    0, // pittariFlag
    "", // batFilePath
    0, // suspendMode
    0, // rebootFlag
    0, // useMargineFlag
    5, // startMargine
    2, // endMargine
    1, // 録画フォルダの数
    "D:\\rec*Write_Default.dll*RecName_Macro.dll?$Title$.ts",
    0, // continueRecFlag
    0, // partialRecFlag
    0, // tunerID
    r.aimai,
    r.notContent,
    r.notDate,
    r.freeCA,
    0, // 部分受信用フォルダの数
    r.chkRecEnd,
    r.chkRecDay,
    "",
  ].join("\t");
}

function rule(over: Partial<EdcbRule> = {}): EdcbRule {
  return {
    id: 1,
    andKey: "",
    notKey: "",
    regExp: false,
    titleOnly: true,
    contents: [],
    dates: [],
    services: [GR_HEX],
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

/** 時分 `(時 << 16) | 分` */
const hm = (hour: number, minute: number) => (hour << 16) | minute;

/** 日本時間の `YYYY/MM/DD` と `HH:MM:SS` */
function jstColumns(at: number): [string, string] {
  const d = new Date(at + 9 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return [
    `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}`,
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`,
  ];
}

/** `Reserve.txt` の1行 */
function reserveLine(over: {
  at: number;
  title: string;
  eventId: number;
  recMode?: number;
  comment?: string;
  id?: number;
}) {
  const [date, time] = jstColumns(over.at);
  return [
    date,
    time,
    "00:30:00",
    over.title,
    "でんぱ総合",
    GR.networkId,
    0x7fe0,
    GR.serviceId,
    over.eventId,
    2,
    1,
    over.id ?? 100,
    over.recMode ?? 1,
    0,
    "0",
    "0",
    over.comment ?? "",
    "D:\\rec*Write_Default.dll*RecName_Macro.dll?$Title$.ts",
    0,
    0,
    "",
    0,
    0,
    0,
    0,
    date,
    time,
    0,
    0,
    0,
    0,
    0,
    0,
    "",
  ].join("\t");
}

/** `RecInfo.txt` の1行。id の列 (最後) は `;;NextID=` の無い古いファイルだと空 */
function recInfoLine(over: {
  title: string;
  at: number;
  epgAt?: number;
  status?: number;
  id?: string;
}) {
  const [date, time] = jstColumns(over.at);
  const [epgDate, epgTime] = jstColumns(over.epgAt ?? over.at);
  return [
    `D:\\rec\\${over.title}.ts`,
    over.title,
    date,
    time,
    "00:30:00",
    "でんぱ総合",
    GR.networkId,
    0x7fe0,
    GR.serviceId,
    1234,
    0,
    0,
    over.status ?? 1,
    epgDate,
    epgTime,
    "録画終了",
    0,
    over.id ?? "",
  ].join("\t");
}

function recInfo2Line(name: string, at: number) {
  const [date, time] = jstColumns(at);
  return [GR.networkId, 0x7fe0, GR.serviceId, date, time, name].join("\t");
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

describe("文字コード", () => {
  test("BOM 付きは UTF-8、BOM 無しは CP932", () => {
    const text = "1\tテスト番組\n";
    expect(decodeText(new TextEncoder().encode(BOM + text))).toBe(text);
    expect(decodeText(SJIS(text))).toBe(text);
  });

  test("CP932 は Windows の表で読む (NEC 特殊文字・波ダッシュ)", () => {
    // テ ス ト ～ ①
    const bytes = new Uint8Array([
      0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x81, 0x60, 0x87, 0x40,
    ]);
    expect(decodeText(bytes)).toBe("テスト～①");
  });

  test("BOM の無い UTF-8 (Unix 用) も読める", () => {
    const text = "1\tテスト番組\n";
    expect(decodeText(new TextEncoder().encode(text))).toBe(text);
  });
});

describe("行と列", () => {
  test("コメントとフッタ、タブの無い行は飛ばす。改行は CRLF でも LF でも", () => {
    const text = [
      "; コメント",
      "a\tb",
      "",
      "タブの無い行",
      "c\td\r",
      ";;NextID=12",
    ].join("\n");
    expect(rowsOf(text)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("時刻は日本時間の壁時計", () => {
    expect(jstAt("2026/10/25", "21:00:00")).toBe(
      Date.UTC(2026, 9, 25, 12, 0, 0),
    );
    // ゼロ埋めでなくても読む
    expect(jstAt("2026/1/2", "3:04:05")).toBe(Date.UTC(2026, 0, 1, 18, 4, 5));
    expect(jstAt("", "")).toBeNull();
  });
});

describe("EpgAutoAdd.txt を読む", () => {
  test("列を拾う。ID が 0 の行は捨てる", () => {
    const text = [
      autoAddLine({
        id: 12,
        andKey: "テスト番組",
        notKey: "再放送",
        contents: "117440512,-65536",
        dates: "1-1310720-1-1376286",
        services: `${GR_HEX},${BS_HEX}`,
        aimai: 1,
        chkRecEnd: 1,
      }),
      autoAddLine({ id: 0 }),
      ";;NextID=13",
    ].join("\r\n");
    const [parsed, ...rest] = parseAutoAdd(BOM + text);
    expect(rest).toEqual([]);
    expect(parsed).toMatchObject({
      id: 12,
      andKey: "テスト番組",
      notKey: "再放送",
      contents: [117440512, -65536],
      dates: ["1-1310720-1-1376286"],
      services: [GR_HEX, BS_HEX],
      aimai: true,
      chkRecEnd: true,
    });
  });

  test("録画フォルダと部分受信用フォルダの数だけ、後ろの列がずれる", () => {
    const columns = autoAddLine({ id: 3, aimai: 1, chkRecEnd: 1 }).split("\t");
    // 録画フォルダを2つに、部分受信用フォルダを1つにする
    columns[19] = "2";
    columns.splice(21, 0, "E:\\rec*Write_Default.dll*");
    const m = 21 + 2 + 6;
    columns[m] = "1";
    columns.splice(m + 1, 0, "F:\\one*Write_Default.dll*");
    const [parsed] = parseAutoAdd(columns.join("\t"));
    expect(parsed?.aimai).toBe(true);
    expect(parsed?.chkRecEnd).toBe(true);
  });

  test("後ろの列が無い古い行は、足りない列を 0 として読む", () => {
    const old = autoAddLine({ id: 5, andKey: "テスト" })
      .split("\t")
      .slice(0, 22)
      .join("\t");
    expect(parseAutoAdd(old)).toMatchObject([
      { id: 5, andKey: "テスト", aimai: false, freeCA: 0, chkRecEnd: false },
    ]);
  });

  test("CP932 のファイルも読める", () => {
    const text = `${autoAddLine({ id: 7, andKey: "テスト番組～" })}\r\n`;
    expect(parseAutoAdd(decodeText(SJIS(text)))[0]?.andKey).toBe(
      "テスト番組～",
    );
  });
});

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
    expect(parseDateList([`1-${hm(20, 0)}-1-${hm(21, 30)}`])).toEqual({
      slot: { time_from: 20 * 60, time_to: 21 * 60 + 31, weekdays: [1] },
      widened: false,
    });
  });

  test("23:59 まではその日の終わりまで、0:00〜23:59 は丸一日", () => {
    expect(parseDateList([`5-${hm(22, 0)}-5-${hm(23, 59)}`])).toEqual({
      slot: { time_from: 22 * 60, time_to: 0, weekdays: [5] },
      widened: false,
    });
    expect(
      parseDateList([`0-${hm(0, 0)}-0-${hm(23, 59)}`, `6-0-6-${hm(23, 59)}`]),
    ).toEqual({
      slot: { time_from: null, time_to: null, weekdays: [0, 6] },
      widened: false,
    });
  });

  test("時刻の同じものは曜日をまとめる", () => {
    const days = [1, 2, 3, 4, 5].map(
      (day) => `${day}-${hm(19, 0)}-${day}-${hm(19, 59)}`,
    );
    expect(parseDateList(days)).toEqual({
      slot: { time_from: 19 * 60, time_to: 20 * 60, weekdays: [1, 2, 3, 4, 5] },
      widened: false,
    });
  });

  test("日をまたぐものは次の日の曜日も足し、そう記す", () => {
    // 月・火の 23:00〜翌 1:00 (EpgTimer の「曜日ごと」の書き方)
    expect(
      parseDateList([
        `1-${hm(23, 0)}-2-${hm(1, 0)}`,
        `2-${hm(23, 0)}-3-${hm(1, 0)}`,
      ]),
    ).toEqual({
      slot: { time_from: 23 * 60, time_to: 61, weekdays: [1, 2, 3] },
      widened: true,
    });
    // 7日そろえば EDCB と同じ
    const all = [0, 1, 2, 3, 4, 5, 6].map(
      (day) => `${day}-${hm(23, 0)}-${(day + 1) % 7}-${hm(1, 0)}`,
    );
    expect(parseDateList(all)).toEqual({
      slot: { time_from: 23 * 60, time_to: 61, weekdays: null },
      widened: false,
    });
  });

  test("時刻の違う時間帯が2つ、2日以上にわたる途中からの時間帯は写せない", () => {
    expect(
      parseDateList([
        `1-${hm(19, 0)}-1-${hm(20, 0)}`,
        `2-${hm(21, 0)}-2-${hm(22, 0)}`,
      ]),
    ).toEqual({ skip: "時刻の違う時間帯が2つ以上あるので取り込めません" });
    expect(parseDateList([`1-${hm(20, 0)}-3-${hm(21, 0)}`])).toHaveProperty(
      "skip",
    );
    // 日 0:00〜土 23:59 は毎日
    expect(parseDateList([`0-0-6-${hm(23, 59)}`])).toEqual({
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
        services: [GR_HEX, BS_HEX.toLowerCase()],
        contents: [134152192, 117440512],
        dates: [`6-${hm(9, 0)}-6-${hm(9, 29)}`],
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
    expect(
      skip({ dates: [`1-${hm(1, 0)}-1-${hm(2, 0)}`], notDate: true }),
    ).toContain("時間帯の NOT");
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
      convertRule(
        rule({ andKey: "テスト", services: [GR_HEX, "7FE87FE80408"] }),
        known,
      ),
    ).toMatchObject({
      values: { service_ids: [GR.id] },
      notes: ["見つからない局を外しました (32744-1032)"],
    });
    expect(
      convertRule(
        rule({ andKey: "テスト", services: ["7FE87FE80408"] }),
        known,
      ),
    ).toEqual({ skip: "局が1つも見つからないので取り込めません" });
  });
});

describe("取り込み", () => {
  test("ルールは下見で数え、取り込みで入れる。もう一度回しても重ならない", async () => {
    const list = parseAutoAdd(
      [
        autoAddLine({ id: 1, andKey: "テスト番組" }),
        autoAddLine({ id: 2, andKey: "テスト", regExp: 1 }),
        autoAddLine({ id: 3, andKey: "テスト", services: "" }),
      ].join("\n"),
    );
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
    const list = parseReserve(
      [
        reserveLine({ at: soon, title: "テスト番組", eventId: 10 }),
        reserveLine({
          at: soon,
          title: "ルールの番組",
          eventId: 12,
          comment: "EPG自動予約(テスト)",
        }),
        reserveLine({
          at: now() - 7200_000,
          title: "終わった番組",
          eventId: 13,
        }),
        reserveLine({ at: soon, title: "無効の番組", eventId: 14, recMode: 5 }),
        reserveLine({ at: soon, title: "時刻だけ", eventId: 0xffff }),
        reserveLine({ at: soon, title: "番組表に無い番組", eventId: 15 }),
        reserveLine({ at: soon, title: "コピー禁止の番組", eventId: 11 }),
        reserveLine({ at: soon, title: "ID が 0", eventId: 16, id: 0 }),
      ].join("\r\n"),
    );
    expect(list).toHaveLength(7);
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

  test("録画の履歴は RecInfo2 を主にし、終わりの時刻を RecInfo で補う。もう一度回しても重ならない", async () => {
    const start = Date.UTC(2026, 8, 1, 12, 0, 0);
    const recInfo2 = parseRecInfo2(
      [
        recInfo2Line("テスト番組 #1", start),
        recInfo2Line("テスト番組 #2", start + 7 * 86400_000),
      ].join("\n"),
    );
    const recInfo = parseRecInfo(
      [
        // #1 は録画が 1 分前から (マージン)。予約したときの番組の開始で RecInfo2 と照らす
        recInfoLine({
          title: "テスト番組 #1",
          at: start - 60_000,
          epgAt: start,
          id: "1",
        }),
        // RecInfo2 に無いもの (古くて消えたなど) は RecInfo から入れる
        recInfoLine({ title: "テスト番組 #0", at: start - 7 * 86400_000 }),
        // 録れなかったものは入れない
        recInfoLine({
          title: "失敗した番組",
          at: start + 86400_000,
          status: 2,
        }),
      ].join("\n"),
    );
    const first = await within(() =>
      importEdcbHistory(recInfo2, recInfo, apply),
    );
    expect(first.history).toEqual({ imported: 3, skipped: 0 });
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
        source: `edcb:recinfo2:32736-32736-1024-${start}`,
      },
      {
        // RecInfo に無いので開始の時刻で代える
        name: "テスト番組 #2",
        service_name: "でんぱ総合",
        end_at: start + 7 * 86400_000,
        source: `edcb:recinfo2:32736-32736-1024-${start + 7 * 86400_000}`,
      },
    ]);

    const again = await within(() =>
      importEdcbHistory(recInfo2, recInfo, apply),
    );
    expect(again.history).toEqual({ imported: 0, skipped: 3 });
    // RecInfo2 から古いものが消えても、RecInfo の側から同じ回を入れ直さない
    const later = await within(() =>
      importEdcbHistory(recInfo2.slice(1), recInfo, apply),
    );
    expect(later.history).toEqual({ imported: 0, skipped: 3 });
    expect(orm().select().from(recordedHistory).all()).toHaveLength(3);
  });

  test("同じ局・同じ開始の行が2つあっても、下見と取り込みで件数がそろう", async () => {
    const start = Date.UTC(2026, 8, 1, 12, 0, 0);
    const recInfo2 = parseRecInfo2(
      [
        recInfo2Line("テスト番組 #1", start),
        recInfo2Line("テスト番組 #1", start),
      ].join("\n"),
    );
    const previewed = await within(() =>
      importEdcbHistory(recInfo2, [], preview),
    );
    const applied = await within(() => importEdcbHistory(recInfo2, [], apply));
    expect(previewed.history).toEqual({ imported: 1, skipped: 0 });
    expect(applied.history).toEqual(previewed.history);
    expect(orm().select().from(recordedHistory).all()).toHaveLength(1);
  });

  test("フォルダから通しで。Setting を中に持つフォルダを指しても、名前の大小が違っても読む", async () => {
    const edcb = join(root, "EDCB");
    const setting = join(edcb, "Setting");
    mkdirSync(setting, { recursive: true });
    writeFileSync(
      join(setting, "EPGAUTOADD.TXT"),
      SJIS(
        `${autoAddLine({ id: 9, andKey: "テスト番組" })}\r\n;;NextID=10\r\n`,
      ),
    );
    writeFileSync(
      join(setting, "RecInfo2.txt"),
      BOM + recInfo2Line("テスト番組 #1", Date.UTC(2026, 8, 1, 12)),
    );
    const files = settingFiles(edcb);
    expect(files?.autoAdd).toBe(join(setting, "EPGAUTOADD.TXT"));
    expect(files?.reserve).toBeUndefined();
    expect(settingFiles(join(root, "どこにも無い"))).toBeNull();

    await runEdcb(files!, apply);
    const result = status();
    expect(result.state).toBe("done");
    expect(result.from).toBe("edcb");
    expect(result.rules).toEqual({ imported: 1, skipped: 0 });
    expect(result.history).toEqual({ imported: 1, skipped: 0 });
    expect(result.log).toContain("Reserve.txt が無いので飛ばします");
    expect(orm().select().from(rules).get()?.name).toBe("テスト番組");
  });
});
