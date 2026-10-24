import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import type { Program, Rule } from "../types";
import {
  compile,
  coveringRule,
  globPatterns,
  matches,
  missOf,
  prefillFrom,
} from "./rules";

/**
 * ルールの判定。DBには触らない (matches は純粋関数にしてある)。
 *
 * 見るのは主に「キーワードをどこに当てるか」。ここを広げすぎると
 * 番宣で名前が出ただけの番組まで録れてしまい、狭すぎると出演者で当たらない。
 */

function rule(fields: Partial<Rule>): Rule {
  return {
    id: 1,
    name: "テスト",
    keyword: "",
    ignore_keyword: "",
    search_fields: "name",
    service_ids: null,
    service_types: null,
    genres: null,
    time_from: null,
    time_to: null,
    weekdays: null,
    enabled: true,
    priority: 2,
    dedupe: false,
    skip_earlier: false,
    source: null,
    created_at: 0,
    ...fields,
  };
}

function program(fields: Partial<Program>): Program {
  return {
    id: 1,
    service_id: 1,
    network_id: 1,
    event_id: 1,
    start_at: 0,
    end_at: 0,
    name: "",
    description: "",
    extended: null,
    genres: null,
    genre_detail: null,
    is_free: true,
    audio_type: null,
    audios: null,
    video_type: null,
    video_resolution: null,
    updated_at: 0,
    ...fields,
  } as Program;
}

const target = program({
  name: "青のオーケストラ",
  description: "第20話「超える」",
  extended: { 出演者: "山田太郎 鈴木花子", 音楽: "だれか" },
});

describe("キーワードを当てる範囲", () => {
  test("既定は番組名だけ", () => {
    expect(matches(rule({ keyword: "青のオーケストラ" }), target)).toBe(true);
    // 概要にしかない語では当たらない
    expect(matches(rule({ keyword: "超える" }), target)).toBe(false);
    expect(matches(rule({ keyword: "山田太郎" }), target)).toBe(false);
  });

  test("概要まで広げる", () => {
    const r = rule({ keyword: "超える", search_fields: "name,description" });
    expect(matches(r, target)).toBe(true);
    expect(matches(rule({ ...r, keyword: "山田太郎" }), target)).toBe(false);
  });

  test("詳細まで広げると出演者で当たる", () => {
    const r = rule({
      keyword: "山田太郎",
      search_fields: "name,description,extended",
    });
    expect(matches(r, target)).toBe(true);
  });

  test("詳細は見出しも探せる", () => {
    expect(
      matches(rule({ keyword: "出演者", search_fields: "extended" }), target),
    ).toBe(true);
  });

  test("範囲が空なら番組名だけに戻す", () => {
    // 全番組に当たってしまうので、指定なしとは解釈しない
    expect(
      matches(rule({ keyword: "青のオーケストラ", search_fields: "" }), target),
    ).toBe(true);
    expect(
      matches(rule({ keyword: "超える", search_fields: "" }), target),
    ).toBe(false);
  });

  test("除外キーワードも同じ範囲で見る", () => {
    const wide = rule({
      keyword: "青の",
      ignore_keyword: "山田太郎",
      search_fields: "name,extended",
    });
    expect(matches(wide, target)).toBe(false);
    // 番組名だけなら出演者は見ないので落ちない
    expect(matches(rule({ ...wide, search_fields: "name" }), target)).toBe(
      true,
    );
  });

  test("空白区切りは全部含むもの", () => {
    const r = rule({
      keyword: "青の 超える",
      search_fields: "name,description",
    });
    expect(matches(r, target)).toBe(true);
    expect(matches(rule({ ...r, keyword: "青の 届かない" }), target)).toBe(
      false,
    );
  });

  test("外字は昔の書き方のキーワードでも当たる (吉 → 𠮷、[新] → 🈟)", () => {
    const aired = program({ name: "🈟𠮷野家の1日🈑" });
    expect(matches(rule({ keyword: "吉野家" }), aired)).toBe(true);
    expect(matches(rule({ keyword: "[新]" }), aired)).toBe(true);
    expect(matches(rule({ keyword: "[字]" }), aired)).toBe(true);
    expect(
      matches(
        rule({ keyword: "アニメ", ignore_keyword: "[新]" }),
        program({ name: "🈟アニメ" }),
      ),
    ).toBe(false);
  });

  test("放送のとおりの全角の番組名にも、半角で打ったキーワードで当たる", () => {
    const aired = program({ name: "Ｖｅｎｕｅ１０１　＃３［字］" });
    expect(matches(rule({ keyword: "venue101" }), aired)).toBe(true);
    expect(matches(rule({ keyword: "Venue101 [字]" }), aired)).toBe(true);
    expect(
      matches(rule({ keyword: "venue101", ignore_keyword: "#3" }), aired),
    ).toBe(false);
  });
});

describe("下見の SQL 前絞り (globPatterns)", () => {
  const compiledOf = (keyword: string, search_fields = "name") =>
    compile(rule({ keyword, search_fields }));

  test("空白区切りの語ごとに *語* を作る。英数は全角・大文字も当たる組にする", () => {
    expect(globPatterns(compiledOf("名探偵 ＮＨＫ"))).toEqual([
      "*名探偵*",
      "*[ｎＮnN][ｈＨhH][ｋＫkK]*",
    ]);
    expect(globPatterns(compiledOf("第#5話"))).toEqual(["*第[＃#][５5]話*"]);
  });

  test("GLOB の記号も字そのものとして当てる", () => {
    expect(globPatterns(compiledOf("名*前?"))).toEqual(["*名[＊*]前[？?]*"]);
    expect(globPatterns(compiledOf("名]-^前"))).toEqual([
      "*名[]］][－-][＾^]前*",
    ]);
  });

  test("大文字小文字を持つ非 ASCII の語は使わない (組を作れない)", () => {
    expect(globPatterns(compiledOf("名探偵 Привет"))).toEqual(["*名探偵*"]);
    expect(globPatterns(compiledOf("Привет"))).toBeNull();
  });

  test("詳細説明まで検索するときは SQL では当てない", () => {
    expect(
      globPatterns(compiledOf("名探偵", "name,description,extended")),
    ).toBeNull();
    expect(globPatterns(compiledOf("名探偵", "name,description"))).toEqual([
      "*名探偵*",
    ]);
  });

  test("語が無ければ null", () => {
    expect(globPatterns(compiledOf(""))).toBeNull();
  });

  test("外字に寄せた字が絡む所は抜く (DB には 𠮷 🈟 のまま入っている)", () => {
    expect(globPatterns(compiledOf("吉野家"))).toEqual(["*野家*"]);
    expect(globPatterns(compiledOf("[新]アニメ"))).toEqual(["*アニメ*"]);
    expect(globPatterns(compiledOf("[新]"))).toBeNull();
  });

  /** 番組名は放送のとおり全角混じり。半角で打った語で SQLite が実際に当てるか */
  test("SQLite の GLOB が全角・半角・大文字小文字の混じった番組名に当たる", () => {
    const db = new Database(":memory:");
    const names = [
      "Ｖｅｎｕｅ１０１",
      "VENUE101",
      "ｖｅｎｕｅ101",
      "venue 101",
      "[新]アニメ*",
      "ニュース",
      "テスト-^記号",
      "テスト－＾記号",
      "テスト^-記号",
    ];
    const hit = (keyword: string) =>
      names.filter((name) =>
        (globPatterns(compiledOf(keyword)) ?? []).every(
          (pattern) =>
            (
              db.query("SELECT ? GLOB ? AS hit").get(name, pattern) as {
                hit: number;
              }
            ).hit === 1,
        ),
      );
    expect(hit("venue101")).toEqual([
      "Ｖｅｎｕｅ１０１",
      "VENUE101",
      "ｖｅｎｕｅ101",
    ]);
    expect(hit("Venue 101")).toEqual([
      "Ｖｅｎｕｅ１０１",
      "VENUE101",
      "ｖｅｎｕｅ101",
      "venue 101",
    ]);
    expect(hit("アニメ*")).toEqual(["[新]アニメ*"]);
    // 組の中の - と ^ も字そのもの (範囲や否定にならない)
    expect(hit("-^記号")).toEqual(["テスト-^記号", "テスト－＾記号"]);
    db.close();
  });
});

/** 録画から作るルールの下書きと、このシリーズを既に録っているルール */
describe("録画からルールを作る", () => {
  const recording = {
    name: "[新]テストアニメ #1「はじまり」[字]",
    service_id: 211,
    genre_detail: [{ lv1: 7, lv2: 0 }],
    start_at: 0,
  };

  test("キーワードはシリーズ名だけ。ジャンルは入れない (全ジャンル)", () => {
    expect(prefillFrom(recording)).toEqual({ keyword: "テストアニメ" });
    expect(prefillFrom({ ...recording, genre_detail: null })).toEqual({
      keyword: "テストアニメ",
    });
  });

  test("鍵括弧の作品名に編が続くタイトルは、作品名だけをキーワードにする", () => {
    expect(
      prefillFrom({
        ...recording,
        name: "[新]「東京リベンジャーズ」三天戦争編 第51話【アニメイズム】",
      })?.keyword,
    ).toBe("東京リベンジャーズ");
  });

  test("頭の枠の名前 (アニメ　/ アニメA・) はキーワードに入れない", () => {
    expect(
      prefillFrom({
        ...recording,
        name: "[新]アニメ　テストアニメです。　第1話",
      })?.keyword,
    ).toBe("テストアニメです。");
    expect(
      prefillFrom({
        ...recording,
        name: "[字]アニメA・テストアニメ #2「契約」",
      })?.keyword,
    ).toBe("テストアニメ");
  });

  test("期・シーズンの表記はキーワードに入れない (次の期にも当てる)", () => {
    for (const name of [
      "[新]テストアニメ Season 2 #1「再会」",
      "テストアニメ season2 第3話",
      "[字]テストアニメ　２ｎｄ　ｓｅａｓｏｎ　＃４",
      "テストアニメ 第2期 #5",
      "アニメ　テストアニメ　シーズン2　第6話",
      "テストアニメ【第3シーズン】 #7",
      "テストアニメ（Season 2） #8",
    ]) {
      expect(prefillFrom({ ...recording, name })?.keyword, name).toBe(
        "テストアニメ",
      );
    }
    expect(
      prefillFrom({ ...recording, name: "テストアイドル 1期生の旅 #3" })
        ?.keyword,
    ).toBe("テストアイドル 1期生の旅");
  });

  test("番組名が空なら下書きは作らない", () => {
    expect(prefillFrom({ ...recording, name: "" })).toBeNull();
  });

  test("シリーズ名に当たるルールがあればそれを返す。無効のものより有効のものを先に", () => {
    const off = rule({ id: 1, keyword: "テストアニメ", enabled: false });
    const on = rule({ id: 2, keyword: "テスト アニメ" });
    expect(coveringRule([off, on], recording)?.id).toBe(2);
    expect(coveringRule([off], recording)?.id).toBe(1);
  });

  test("録れた回のタイトルにしか当たらないルール ([新]) は、シリーズを録っているとは言わない", () => {
    expect(
      coveringRule([rule({ keyword: "[新]" })], recording),
    ).toBeUndefined();
  });

  test("ジャンルや局で外れるルールは当たらない", () => {
    expect(
      coveringRule(
        [rule({ keyword: "テストアニメ", genres: ["1"] })],
        recording,
      ),
    ).toBeUndefined();
    expect(
      coveringRule(
        [rule({ keyword: "テストアニメ", service_ids: [999] })],
        recording,
      ),
    ).toBeUndefined();
    // 時間帯と曜日は録画の始まる時刻で見る (start_at 0 は日本時間の木曜 9:00)
    expect(
      coveringRule(
        [
          rule({
            keyword: "テストアニメ",
            time_from: 19 * 60,
            time_to: 20 * 60,
          }),
        ],
        recording,
      ),
    ).toBeUndefined();
    expect(
      coveringRule(
        [
          rule({
            keyword: "テストアニメ",
            time_from: 9 * 60,
            time_to: 10 * 60,
            weekdays: [4],
          }),
        ],
        recording,
      )?.keyword,
    ).toBe("テストアニメ");
  });
});

/** 番組表・予約の詳細から。番組はシリーズ名を持たないので、タイトルから切り出す */
describe("番組からルールを作る", () => {
  const program = {
    name: "[新]テストアニメ #1「はじまり」[字]",
    service_id: 211,
    genre_detail: [{ lv1: 7, lv2: 0 }],
    start_at: 0,
  };

  test("キーワードはタイトルから切り出したシリーズ名だけ。ジャンルは入れない (全ジャンル)", () => {
    expect(prefillFrom(program)).toEqual({ keyword: "テストアニメ" });
    expect(prefillFrom({ ...program, genre_detail: null })).toEqual({
      keyword: "テストアニメ",
    });
  });

  test("このシリーズを録っているルールを返す。[新] だけのルールは当たらない", () => {
    expect(
      coveringRule([rule({ id: 3, keyword: "テストアニメ" })], program)?.id,
    ).toBe(3);
    expect(coveringRule([rule({ keyword: "[新]" })], program)).toBeUndefined();
  });
});

/**
 * **当たらない理由** (`missOf`)。検索の結果の行に「録らない (局)」のように出す。
 * 判定は `matchesCompiled` と同じもの (理由が無ければ当たる)
 */
describe("当たらない理由", () => {
  const miss = (
    fields: Partial<Rule>,
    p: Program,
    type = "GR",
    freeOnly = true,
  ) =>
    missOf(compile(rule(fields)), p, type, freeOnly, (f) =>
      f.includes("name") ? p.name : "",
    );
  const anime = program({
    name: "テストアニメ #1",
    service_id: 7,
    genre_detail: [{ lv1: 7, lv2: 0 }],
  });

  test("当たれば null", () => {
    expect(miss({ keyword: "テストアニメ" }, anime)).toBeNull();
  });
  test("有料放送 (無料放送だけのとき)", () => {
    expect(
      miss({ keyword: "テストアニメ" }, { ...anime, is_free: false }),
    ).toBe("paid");
    expect(
      miss(
        { keyword: "テストアニメ" },
        { ...anime, is_free: false },
        "GR",
        false,
      ),
    ).toBeNull();
  });
  test("局・種別", () => {
    expect(miss({ keyword: "テストアニメ", service_ids: [8] }, anime)).toBe(
      "service",
    );
    expect(
      miss({ keyword: "テストアニメ", service_types: ["BS"] }, anime),
    ).toBe("service");
    expect(
      miss({ keyword: "テストアニメ", service_types: ["GR"] }, anime),
    ).toBeNull();
  });
  test("ジャンル", () => {
    expect(miss({ genres: ["1"] }, anime)).toBe("genre");
    expect(miss({ genres: ["7"] }, anime)).toBeNull();
  });
  test("条件が何も無い", () => {
    expect(miss({}, anime)).toBe("empty");
  });
  test("キーワードを含まない・除外する言葉を含む", () => {
    expect(miss({ keyword: "ニュース" }, anime)).toBe("keyword");
    expect(
      miss({ keyword: "テストアニメ", ignore_keyword: "再放送 #1" }, anime),
    ).toBe("ignore");
  });
});

describe("時間帯と曜日", () => {
  /** 日本時間の 2026-10-23 (金) の hh:mm。テストの TZ によらない */
  const friday = (hours: number, minutes = 0) =>
    Date.UTC(2026, 9, 23, hours - 9, minutes);
  const at = (start_at: number) =>
    program({ name: "テストニュース", start_at });
  const miss = (fields: Partial<Rule>, p: Program) =>
    missOf(
      compile(rule({ keyword: "テストニュース", ...fields })),
      p,
      "GR",
      true,
      (f) => (f.includes("name") ? p.name : ""),
    );
  const evening = { time_from: 19 * 60, time_to: 20 * 60 };

  test("始まる時刻が from 以上 to 未満なら当たる", () => {
    expect(miss(evening, at(friday(19)))).toBeNull();
    expect(miss(evening, at(friday(19, 59)))).toBeNull();
    // 端: to ちょうどは外、from の 1 分前も外
    expect(miss(evening, at(friday(20)))).toBe("time");
    expect(miss(evening, at(friday(18, 59)))).toBe("time");
  });

  test("from > to は日をまたぐ", () => {
    const night = { time_from: 23 * 60, time_to: 2 * 60 };
    expect(miss(night, at(friday(23)))).toBeNull();
    expect(miss(night, at(friday(0)))).toBeNull();
    expect(miss(night, at(friday(1, 59)))).toBeNull();
    expect(miss(night, at(friday(2)))).toBe("time");
    expect(miss(night, at(friday(22, 59)))).toBe("time");
  });

  test("0:00 で終わる時間帯は 23:59 まで", () => {
    const late = { time_from: 23 * 60, time_to: 0 };
    expect(miss(late, at(friday(23, 59)))).toBeNull();
    expect(miss(late, at(friday(0)))).toBe("time");
  });

  test("曜日は始まる時刻の暦の曜日 (日本時間)", () => {
    // 金曜 (5) の 0:30 は日本時間では金曜。UTC では木曜
    expect(miss({ weekdays: [5] }, at(friday(0, 30)))).toBeNull();
    expect(miss({ weekdays: [4] }, at(friday(0, 30)))).toBe("weekday");
    // 日曜は 0
    expect(
      miss({ weekdays: [0] }, at(Date.UTC(2026, 9, 25, 12 - 9))),
    ).toBeNull();
  });

  test("日をまたぐ時間帯でも曜日は始まる日で見る", () => {
    const fridayNight = { time_from: 23 * 60, time_to: 2 * 60, weekdays: [5] };
    expect(miss(fridayNight, at(friday(23, 30)))).toBeNull();
    // 金曜 23 時からの続きの土曜 1 時は土曜なので外
    expect(miss(fridayNight, at(friday(25)))).toBe("weekday");
    // 金曜の 1 時は入る
    expect(miss(fridayNight, at(friday(1)))).toBeNull();
  });

  test("両方空ならいつでも。片方だけ・同じ値の行は時間帯なし", () => {
    expect(miss({}, at(friday(3)))).toBeNull();
    expect(miss({ time_from: 19 * 60 }, at(friday(3)))).toBeNull();
    expect(
      miss({ time_from: 19 * 60, time_to: 19 * 60 }, at(friday(3))),
    ).toBeNull();
    // 7日とも選んだものは毎日
    expect(miss({ weekdays: [0, 1, 2, 3, 4, 5, 6] }, at(friday(3)))).toBeNull();
  });

  test("時間帯や曜日だけでは条件にならない (その時間の全局に当たるので当てない)", () => {
    const bare = (fields: Partial<Rule>, p: Program) =>
      missOf(compile(rule(fields)), p, "GR", true, () => p.name);
    expect(bare({ weekdays: [5] }, at(friday(12)))).toBe("empty");
    expect(bare(evening, at(friday(19)))).toBe("empty");
    expect(bare(evening, at(friday(12)))).toBe("empty");
    // 局が入れば、時間帯は絞り込みとして効く
    expect(
      bare({ ...evening, service_types: ["GR"] }, at(friday(19))),
    ).toBeNull();
    expect(bare({ ...evening, service_types: ["GR"] }, at(friday(12)))).toBe(
      "time",
    );
    expect(bare({}, at(friday(12)))).toBe("empty");
  });
});
