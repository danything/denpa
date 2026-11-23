import { describe, expect, test } from "bun:test";

import {
  learnHeads,
  segmentsOf,
  seriesNames,
  type SeriesRow,
  splitSeries,
  stationKey,
  strictSeries,
} from "./series";

/** 局 `a` の行。`titles` は見た回の種類 (2 で続いている) */
const row = (
  series: string,
  titles = 1,
  station = "a",
  movieOnly = false,
): SeriesRow => ({ station, series, titles, movieOnly });

/** 行から学んで、番組名をシリーズ名にする */
function seriesOf(rows: SeriesRow[], name: string): string {
  return splitSeries(name, learnHeads(rows).heads).series;
}

describe("segmentsOf", () => {
  test("全角の空白と【「『＜ ▽▼ ～ の前で区切る", () => {
    expect(segmentsOf("おんがく交差点【民族楽器】")).toEqual([
      "おんがく交差点",
      "【民族楽器】",
    ]);
    expect(
      segmentsOf("ダークサイドミステリー　連続怪死！　謎の毒事件"),
    ).toEqual(["ダークサイドミステリー", "　連続怪死！", "　謎の毒事件"]);
    expect(segmentsOf("ピタゴラスイッチ▽うた")).toEqual([
      "ピタゴラスイッチ",
      "▽うた",
    ]);
  });

  test("英数字の間の全角の空白と、括弧の中では区切らない", () => {
    expect(segmentsOf("ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　α")).toEqual([
      "ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ",
      "　α",
    ]);
    expect(segmentsOf("頭文字[イニシャル]D Second Stage")).toEqual([
      "頭文字[イニシャル]D Second Stage",
    ]);
    expect(segmentsOf("よしもと新喜劇(2014～) 白川郷")).toEqual([
      "よしもと新喜劇(2014～) 白川郷",
    ]);
  });

  test("先頭の枠の印の後ろで区切る", () => {
    expect(segmentsOf("【KNTV】愛だと言って")).toEqual([
      "【KNTV】",
      "愛だと言って",
    ]);
    expect(segmentsOf("[見]【名車一挙】名車再生！")).toEqual([
      "[見]",
      "【名車一挙】",
      "名車再生！",
    ]);
    expect(segmentsOf("将棋）めざせプロ棋士")).toEqual([
      "将棋）",
      "めざせプロ棋士",
    ]);
  });
});

describe("learnHeads / splitSeries", () => {
  test("その回のタイトルを続ける番組は、何度も出る先頭をシリーズ名にする。残りは副題の前に回す", () => {
    const rows = [
      row("おんがく交差点【民族楽器×歌うヴァイオリン名曲集】"),
      row("おんがく交差点【『攻殻機動隊』を歌う民謡の達人？】"),
    ];
    expect(
      splitSeries(
        "おんがく交差点【『攻殻機動隊』を歌う民謡の達人？】🈑",
        learnHeads(rows).heads,
      ),
    ).toEqual({
      series: "おんがく交差点",
      rest: "【『攻殻機動隊』を歌う民謡の達人？】",
    });
    // 先頭だけの名前 (先頭を学んだあとに来たもの) も同じシリーズ
    expect(seriesOf(rows, "おんがく交差点")).toBe("おんがく交差点");
  });

  test("「選」(NHK の再放送の印) は、外した先頭がほかにもあるときだけ外す", () => {
    const rows = [
      row(
        "ダークサイドミステリー　連続怪死！妻たちが死神になった村　謎の毒事件",
      ),
      row("ダークサイドミステリー選　歴史の闇！ヒトラーは生きている？"),
    ];
    expect(
      seriesOf(
        rows,
        "ダークサイドミステリー　連続怪死！妻たちが死神になった村　謎の毒事件🈑",
      ),
    ).toBe("ダークサイドミステリー");
    expect(
      seriesOf(
        rows,
        "ダークサイドミステリー選　歴史の闇！ヒトラーは生きている？",
      ),
    ).toBe("ダークサイドミステリー");
    // 外した先頭がほかに無ければ外さない
    expect(segmentsOf("サスペンス名作選　X")[0]).toBe("サスペンス名作選");
    expect(
      seriesOf(
        [row("サスペンス名作選　X"), row("サスペンス名作選　Y")],
        "サスペンス名作選　X",
      ),
    ).toBe("サスペンス名作選");
  });

  test("同じ回の再放送だけなら、先頭を採らない", () => {
    expect(seriesOf([row("番組　回のタイトル")], "番組　回のタイトル")).toBe(
      "番組　回のタイトル",
    );
  });

  test("続いている子が 2 つ以上ある先頭は枠。どの局でも採らない", () => {
    const rows = [
      row("韓国ドラマ　復讐の化身", 2),
      row("韓国ドラマ　イ・サン", 2),
      row("韓国ドラマ　一挙の作品"),
      row("韓国ドラマ　シンデレラゲーム", 1, "b"),
      row("韓国ドラマ　危険な約束", 1, "b"),
    ];
    expect(seriesOf(rows, "韓国ドラマ　一挙の作品")).toBe(
      "韓国ドラマ　一挙の作品",
    );
    expect(seriesOf(rows, "韓国ドラマ　危険な約束")).toBe(
      "韓国ドラマ　危険な約束",
    );
  });

  test("続いている子は分けたまま。その子だけの名前もその子のシリーズ", () => {
    const rows = [
      row("ＮＨＫニュース　おはよう日本", 2),
      row("ＮＨＫニュース　おはよう首都圏"),
      row("ＮＨＫニュース　特設"),
      row("ＮＨＫニュース　おはよう日本　首里城"),
      row("ＮＨＫニュース　おはよう日本　ＣＯＰ"),
    ];
    expect(seriesOf(rows, "ＮＨＫニュース　おはよう首都圏")).toBe(
      "ＮＨＫニュース",
    );
    expect(seriesOf(rows, "ＮＨＫニュース　おはよう日本")).toBe(
      "ＮＨＫニュース　おはよう日本",
    );
    expect(seriesOf(rows, "ＮＨＫニュース　おはよう日本　首里城")).toBe(
      "ＮＨＫニュース　おはよう日本",
    );
  });

  test("枠の印だけの先頭と、3 文字未満の先頭は採らない", () => {
    expect(
      seriesOf(
        [row("【KNTV】愛だと言って"), row("【KNTV】熱血司祭２")],
        "【KNTV】愛だと言って",
      ),
    ).toBe("【KNTV】愛だと言って");
    expect(
      seriesOf(
        [
          row("映画『冬の華』▽高倉健×倉本聰作品"),
          row("映画『大脱出』▽二大スター競演"),
        ],
        "映画『冬の華』▽高倉健×倉本聰作品",
      ),
    ).toBe("映画『冬の華』▽高倉健×倉本聰作品");
  });

  test("映画だけの番組は「作品名」の前で切らない。映画とほかのジャンルが付いた番組は切る", () => {
    const movies = [
      row("シネマ「飢餓海峡」＜レターボックスサイズ＞", 1, "a", true),
      row("シネマ「トラ・トラ・トラ！」＜字幕スーパー＞", 1, "a", true),
    ];
    expect(seriesOf(movies, "シネマ「飢餓海峡」＜レターボックスサイズ＞")).toBe(
      "シネマ「飢餓海峡」＜レターボックスサイズ＞",
    );
    const talk = [
      row("永野映画ＣＨＡＮＮＥＬ「恋する惑星」【字幕】"),
      row("永野映画ＣＨＡＮＮＥＬ「リトル★ニッキー」【字幕】"),
    ];
    expect(seriesOf(talk, "永野映画ＣＨＡＮＮＥＬ「恋する惑星」【字幕】")).toBe(
      "永野映画ＣＨＡＮＮＥＬ",
    );
  });

  test("英数字の間の全角の空白では切らない", () => {
    const rows = [
      row("ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　ｄａｙｓ【大雪】"),
      row("ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　ｄａｙｓ【秋晴れ】"),
      row("ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　α"),
    ];
    expect(seriesOf(rows, "ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　α")).toBe(
      "ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　α",
    );
    expect(seriesOf(rows, "ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　ｄａｙｓ【大雪】")).toBe(
      "ＦＮＮ　Ｌｉｖｅ　Ｎｅｗｓ　ｄａｙｓ",
    );
  });

  test("ほかの局で採った先頭は、分かれが 1 つの局にも当てる (同じ番組名が局で割れない)", () => {
    const rows = [
      row("徹子の部屋　森山良子"),
      row("徹子の部屋　ゲスト"),
      row("徹子の部屋　ガレッジセール", 1, "b"),
    ];
    expect(seriesOf(rows, "徹子の部屋　ガレッジセール")).toBe("徹子の部屋");
  });

  test("切った名前は番組名の字のまま (全角は全角)。先頭の有無で枠の名前 (アニメ) を行き来しない", () => {
    const rows = [
      row("ドラマ１０「会社員」", 2),
      row("ドラマ１０「会社員」物語は最終章へ！"),
      row("ドラマ１０「会社員」撮影の舞台裏"),
    ];
    const { heads } = learnHeads(rows);
    expect(splitSeries("ドラマ１０「会社員」（７）🈖🈑", heads).series).toBe(
      "ドラマ１０「会社員」",
    );
    expect(
      splitSeries("アニメ　無脳魔女　ｓｅａｓｏｎ２　１話～３話", new Set())
        .series,
    ).toBe(strictSeries("アニメ　無脳魔女　ｓｅａｓｏｎ２　１話～３話"));
    expect(strictSeries("アニメ　無脳魔女　ｓｅａｓｏｎ２　１話～３話")).toBe(
      "無脳魔女　ｓｅａｓｏｎ２",
    );
  });

  test("渡す行の順を入れ替えても、学ぶ先頭は同じ", () => {
    const rows = [
      row("おんがく交差点【A】"),
      row("おんがく交差点【B】"),
      row("韓国ドラマ　X", 2),
      row("韓国ドラマ　Y", 2),
      row("ＮＨＫニュース　おはよう日本", 2),
      row("ＮＨＫニュース　特設"),
      row("徹子の部屋　A", 1, "b"),
      row("徹子の部屋　B", 1, "c"),
      row("徹子の部屋　C", 1, "c"),
    ];
    const sorted = (heads: Set<string>) => [...heads].sort();
    const once = learnHeads(rows);
    expect(sorted(learnHeads([...rows].reverse()).heads)).toEqual(
      sorted(once.heads),
    );
    expect(
      sorted(
        learnHeads([rows[4]!, ...rows.slice(5), ...rows.slice(0, 4)]).heads,
      ),
    ).toEqual(sorted(once.heads));
  });
});

describe("seriesNames", () => {
  test("録画の列に入りうる名前を全部返す (今の決め方・枠の名前を外す前・切れ端ごとの先頭・「選」を外したもの)", () => {
    expect(seriesNames("アニメ　X　回のタイトル")).toEqual(
      expect.arrayContaining([
        "アニメ　X　回のタイトル",
        "X　回のタイトル",
        "X",
      ]),
    );
    expect(seriesNames("ダークサイドミステリー選　歴史の闇")).toEqual(
      expect.arrayContaining([
        "ダークサイドミステリー選　歴史の闇",
        "ダークサイドミステリー選",
        "ダークサイドミステリー",
      ]),
    );
  });
});

describe("stationKey", () => {
  test("局名を半角に寄せて空白を除く。空なら学ばない", () => {
    expect(stationKey("ＬａＬａＴＶ")).toBe(stationKey("LaLa TV"));
    expect(stationKey(" ")).toBeNull();
  });
});
