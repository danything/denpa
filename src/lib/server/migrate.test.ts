import { describe, expect, test } from "bun:test";

import { number, object } from "#lib/shape.js";

import {
  type EpgstationRule,
  parseSource,
  readVersion,
  validItems,
} from "./epgstation-api";
import { chooseFile, convertRule, parseGenres, parseTimes } from "./migrate";

/**
 * EPGStation のジャンル指定 (`searchOption.genres`) の読み取り。
 *
 * ここを取りこぼすと、引き継いだルールのジャンル欄に名前の引けない値が並ぶ。
 * denpa 側は文字列で `"7"`(大分類だけ)と `"7-0"`(中分類まで)を持つ。
 */
describe("ジャンルの引き継ぎ", () => {
  test("中分類まであれば大分類と繋ぐ", () => {
    expect(parseGenres([{ genre: 7, subGenre: 0 }])).toEqual(["7-0"]);
  });

  test("大分類だけなら大分類だけ", () => {
    // EPGStation で「アニメ全部」を選んだとき subGenre は入ってこない
    expect(parseGenres([{ genre: 7 }])).toEqual(["7"]);
  });

  test("数値の配列でも読める", () => {
    expect(parseGenres([7, 6])).toEqual(["7", "6"]);
  });

  test("引ける形式にならないものは落とす", () => {
    // 残すと画面のジャンル欄に名前の引けない値が並ぶ
    expect(
      parseGenres([null, { subGenre: 1 }, { genre: "7" }, 7, 1.5]),
    ).toEqual(["7"]);
  });

  test("配列でなければ空で返す", () => {
    expect(parseGenres(undefined)).toEqual([]);
    expect(parseGenres(null)).toEqual([]);
    expect(parseGenres("[7]")).toEqual([]);
    expect(parseGenres({ genre: 7 })).toEqual([]);
  });
});

/**
 * EPGStation の時間帯と曜日 (`searchOption.times`)。`start` / `range` は時、`week` は日曜 0x01〜土曜 0x40 のビット。
 * 向こうは番組の始まる「時」が `start`〜`start + range - 1` なら当てる
 */
describe("時間帯と曜日の引き継ぎ", () => {
  const anytime = { time_from: null, time_to: null, weekdays: null };

  test("時刻は分に、曜日はビットから", () => {
    // 金曜 (0x20) の 19 時から 2 時間
    expect(parseTimes([{ start: 19, range: 2, week: 32 }])).toEqual({
      time_from: 19 * 60,
      time_to: 21 * 60,
      weekdays: [5],
    });
  });

  test("日をまたぐ時間帯は終わりが小さくなる", () => {
    // 土日 (0x41) の 23 時から 3 時間 = 23:00〜02:00
    expect(parseTimes([{ start: 23, range: 3, week: 65 }])).toEqual({
      time_from: 23 * 60,
      time_to: 2 * 60,
      weekdays: [0, 6],
    });
  });

  test("毎日・時刻なしはいつでも。無いものや形の違うものも", () => {
    expect(parseTimes([{ week: 127 }])).toEqual(anytime);
    expect(parseTimes(undefined)).toEqual(anytime);
    expect(parseTimes([])).toEqual(anytime);
    expect(parseTimes("[]")).toEqual(anytime);
    // 曜日が 0 の行は向こうも飛ばす
    expect(parseTimes([{ start: 1, range: 1, week: 0 }])).toEqual(anytime);
  });

  test("曜日だけで絞る", () => {
    // 月〜金
    expect(parseTimes([{ week: 62 }])).toEqual({
      time_from: null,
      time_to: null,
      weekdays: [1, 2, 3, 4, 5],
    });
  });

  test("時刻の同じ行は曜日を足す。時刻の違う行があれば写せない", () => {
    expect(
      parseTimes([
        { start: 19, range: 1, week: 2 },
        { start: 19, range: 1, week: 4 },
      ]),
    ).toEqual({ time_from: 19 * 60, time_to: 20 * 60, weekdays: [1, 2] });
    expect(
      parseTimes([
        { start: 19, range: 1, week: 2 },
        { start: 21, range: 1, week: 2 },
      ]),
    ).toBeNull();
  });
});

/** ルール1つの写し方 (`convertRule`)。局は denpa にあるもの (1・2) だけを引ける */
describe("ルールの写し方", () => {
  const known = new Set([1, 2]);
  const serviceOf = (id: number) => (known.has(id) ? id : undefined);
  const rule = (
    searchOption: Record<string, unknown>,
    over: Record<string, unknown> = {},
  ) =>
    ({
      id: 9,
      isTimeSpecification: false,
      searchOption,
      reserveOption: { enable: true, avoidDuplicate: true },
      ...over,
    }) as unknown as EpgstationRule;

  test("キーワード・範囲・種別・局・ジャンル・時間帯・重複を避ける", () => {
    const converted = convertRule(
      rule({
        keyword: "テストアニメ",
        ignoreKeyword: "再放送",
        name: true,
        description: true,
        extended: false,
        GR: true,
        BS: true,
        channelIds: [1, 2],
        genres: [{ genre: 7 }],
        times: [{ start: 23, range: 2, week: 1 }],
      }),
      serviceOf,
    );
    expect(converted).toEqual({
      values: {
        name: "テストアニメ",
        keyword: "テストアニメ",
        ignore_keyword: "再放送",
        search_fields: "name,description",
        service_ids: [1, 2],
        service_types: ["GR", "BS"],
        genres: ["7"],
        time_from: 23 * 60,
        time_to: 1 * 60,
        weekdays: [0],
        enabled: true,
        dedupe: true,
      },
      notes: [],
    });
  });

  test("写すと当たる番組が変わるものは飛ばす", () => {
    const skip = (option: Record<string, unknown>, over = {}) => {
      const converted = convertRule(
        rule({ keyword: "テスト", ...option }, over),
        serviceOf,
      );
      return "skip" in converted ? converted.skip : null;
    };
    expect(skip({}, { isTimeSpecification: true })).toContain("時刻指定");
    expect(skip({ keyRegExp: true })).toContain("正規表現");
    expect(skip({ ignoreKeyword: "a|b", ignoreKeyRegExp: true })).toContain(
      "正規表現",
    );
    expect(skip({ durationMin: 600 })).toContain("番組の長さ");
    expect(skip({ searchPeriods: [{ startAt: 0, endAt: 1 }] })).toContain(
      "検索期間",
    );
    expect(
      skip({
        times: [
          { start: 1, range: 1, week: 1 },
          { start: 3, range: 1, week: 1 },
        ],
      }),
    ).toContain("時間帯が2つ以上");
    // 局を全部外すと全局に当たる
    expect(skip({ channelIds: [999] })).toContain("局が1つも");
    // 種別が BS4K だけ。外すと全種別に当たる
    expect(skip({ BS4K: true })).toContain("BS4K だけ");
    expect(skip({ keyword: "" })).toContain("条件が空");
    // 時間帯だけで絞っていたものも、その時間の全番組に当たる
    expect(skip({ keyword: "", times: [{ week: 2 }] })).toContain("条件が空");
  });

  test("BS4K は種別から外し、denpa に無い局は外して、ログに残す", () => {
    const converted = convertRule(
      rule({
        keyword: "高画質",
        BS: true,
        BS4K: true,
        channelIds: [1, 999],
        keyCS: true,
        isFree: true,
      }),
      serviceOf,
    );
    if ("skip" in converted) throw new Error(converted.skip);
    expect(converted.values.service_types).toEqual(["BS"]);
    expect(converted.values.service_ids).toEqual([1]);
    expect(converted.notes).toEqual([
      "BS4K は denpa に無いので種別から外しました",
      "denpa に無い局を 1 件外しました",
      "大文字と小文字の区別は普通の検索として取り込みました",
      "無料放送だけの条件は外して取り込みました (有料放送にも当たります)",
    ]);
  });

  test("形がずれて真偽が 0/1 で来ても読む。searchOption が無ければ条件が空", () => {
    const converted = convertRule(
      rule(
        { keyword: "形違い", name: 1, GR: 1 },
        { reserveOption: { enable: 0, avoidDuplicate: 1 } },
      ),
      serviceOf,
    );
    if ("skip" in converted) throw new Error(converted.skip);
    expect(converted.values).toMatchObject({
      service_types: ["GR"],
      enabled: false,
      dedupe: true,
    });
    const empty = convertRule(
      { id: 6, isTimeSpecification: false } as unknown as EpgstationRule,
      serviceOf,
    );
    expect(empty).toEqual({ skip: "条件が空になるので取り込めません" });
  });

  test("キーワードが空なら名前は EPGStation #<id>", () => {
    const converted = convertRule(rule({ GR: true }), serviceOf);
    if ("skip" in converted) throw new Error(converted.skip);
    expect(converted.values.name).toBe("EPGStation #9");
  });
});

describe("録画のファイルの選び方", () => {
  const recorded = (videoFiles: unknown) =>
    ({
      id: 1,
      name: "x",
      startAt: 0,
      endAt: 1,
      isRecording: false,
      videoFiles,
    }) as Parameters<typeof chooseFile>[0];

  test("エンコード済みを優先し、拡張子は filename から", () => {
    expect(
      chooseFile(
        recorded([
          { id: 1, type: "ts", size: 10, filename: "a.m2ts" },
          { id: 2, type: "encoded", size: 5, filename: "a.mp4" },
          { id: 3, type: "encoded", size: 6, filename: "a.mkv" },
        ]),
      ),
    ).toEqual({ id: 2, size: 5, raw: false, extension: ".mp4" });
  });

  test("元のTSだけなら元のTS。filename が無ければ既定の拡張子", () => {
    expect(chooseFile(recorded([{ id: 1, type: "ts", size: 10 }]))).toEqual({
      id: 1,
      size: 10,
      raw: true,
      extension: ".m2ts",
    });
  });

  test("ID や大きさの無いものは選ばない。無ければ null", () => {
    expect(chooseFile(recorded([{ type: "encoded", size: 5 }]))).toBeNull();
    expect(chooseFile(recorded([]))).toBeNull();
    expect(chooseFile(recorded(undefined))).toBeNull();
  });
});

describe("EPGStation の URL", () => {
  test("資格情報は Authorization に移し、URL からは外す", () => {
    const source = parseSource(
      " http://us%40er:p%3Ass@epgstation:8888/sub/?x=1 ",
    );
    expect(source.base).toBe("http://epgstation:8888/sub");
    expect(source.headers).toEqual({
      Authorization: `Basic ${Buffer.from("us@er:p:ss").toString("base64")}`,
    });
    expect(JSON.stringify(source.base)).not.toContain("p:ss");
  });

  test("壊れた % の資格情報は書かれたまま使う", () => {
    expect(parseSource("http://user:p%zz@epgstation:8888").headers).toEqual({
      Authorization: `Basic ${Buffer.from("user:p%zz").toString("base64")}`,
    });
  });

  test("資格情報が無ければヘッダも無い", () => {
    expect(parseSource("http://epgstation:8888")).toEqual({
      base: "http://epgstation:8888",
      headers: {},
    });
  });

  test("読めない URL・http でないものは理由を投げる", () => {
    expect(() => parseSource("epgstation")).toThrow("読めません");
    expect(() => parseSource("ftp://user:secret@epgstation")).toThrow(
      "http://",
    );
    // 理由に資格情報を出さない
    try {
      parseSource("ftp://user:secret@epgstation");
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  });
});

describe("EPGStation のバージョン", () => {
  test("v2・v3 を見分ける。v1 は扱わない。それ以外は分からないまま続ける", () => {
    expect(readVersion("2.10.0")).toEqual({ text: "2.10.0", major: 2 });
    expect(readVersion("3.0.0-beta4")).toEqual({
      text: "3.0.0-beta4",
      major: 3,
    });
    expect(readVersion("1.7.6")).toBe("v1");
    expect(readVersion("4.0.0")).toEqual({ text: "4.0.0", major: null });
    expect(readVersion("")).toEqual({ text: "", major: null });
  });
});

describe("形の違う応答", () => {
  test("1回だけ警告して続け、id の無い1件だけ飛ばす", () => {
    const warnings: string[] = [];
    const skipped: string[] = [];
    const items = validItems(
      object({ id: number }),
      [{ id: 1 }, { name: "id なし" }, { id: 2.5 }, "文字列", { id: 3 }],
      "試験の一覧",
      ["id"],
      (message) => warnings.push(message),
      (message) => skipped.push(message),
    );
    expect(items).toEqual([{ id: 1 }, { id: 3 }]);
    expect(skipped).toHaveLength(3);
    // 形の違うものは2件あるが、警告は1回
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("試験の一覧の形式が違います");
    expect(skipped[0]).toContain("id が無いので飛ばします");
  });
});
