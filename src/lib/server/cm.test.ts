import { describe, expect, test } from "bun:test";

import { LOGO_OK, logoUnusable } from "../format";
import {
  chapterArgs,
  chapterMetadata,
  cmRatio,
  decideFromMaterial,
  fields,
  firstFrameTime,
  invertRanges,
  leadIn,
  liveAudioIndexes,
  logoDetail,
  parseFrameRate,
  parseRatio,
  shiftRanges,
  tooMuchCm,
} from "./cm";
import type { CmMaterial } from "./cm-material";

describe("区間の裏返し", () => {
  test("CM を渡すと残す区間になる", () => {
    expect(invertRanges([{ start: 300, end: 360 }], 1800)).toEqual([
      { start: 0, end: 300 },
      { start: 360, end: 1800 },
    ]);
  });

  test("先頭が CM なら本編は 1 区間だけ", () => {
    expect(invertRanges([{ start: 0, end: 60 }], 600)).toEqual([
      { start: 60, end: 600 },
    ]);
  });

  test("並んでいなくても同じ答えになる", () => {
    expect(
      invertRanges(
        [
          { start: 160, end: 600 },
          { start: 0, end: 100 },
        ],
        600,
      ),
    ).toEqual([{ start: 100, end: 160 }]);
  });
});

/**
 * エンコードは先頭 (音声だけの区間) を捨てて 0 秒から始めるので、チャプターの
 * 時刻も同じだけ詰める。そのままだと自動スキップが毎回そのぶん CM を見せていた
 */
describe("チャプターの時刻を頭出しに合わせる", () => {
  test("捨てたぶんだけ前へ詰める", () => {
    expect(shiftRanges([{ start: 300, end: 360 }], 0.9)).toEqual([
      { start: 299.1, end: 359.1 },
    ]);
  });

  test("0 より前には行かない (先頭が CM の録画)", () => {
    expect(shiftRanges([{ start: 0.2, end: 60 }], 0.9)).toEqual([
      { start: 0, end: 59.1 },
    ]);
  });

  test("詰めた結果ほとんど残らない区間は落とす", () => {
    expect(shiftRanges([{ start: 0, end: 1 }], 0.9)).toEqual([]);
  });

  test("捨てるものが無ければそのまま", () => {
    const cm = [{ start: 10, end: 20 }];
    expect(shiftRanges(cm, 0)).toBe(cm);
  });
});

/*
 * **頭出しは「実際にデコードできた 1 コマ目」で測る。**
 *
 * stream の `start_time` は最初のパケットの時刻で、そこから何コマかは
 * 参照先が録れておらず捨てられる。実機ではその差が 0.567 秒 (17 コマ = 半 GOP) で、
 * そのぶんだけ字幕が早く出ていた。
 */
describe("最初にデコードできたコマ", () => {
  const output = [
    "best_effort_timestamp_time=6116.439489",
    "best_effort_timestamp_time=6116.472856",
    "best_effort_timestamp_time=6116.506222",
  ].join("\n");

  test("先頭の 1 件を読む", () => {
    expect(firstFrameTime(output)).toBeCloseTo(6116.439489, 6);
  });

  test("1 件も無ければ NaN (呼ぶ側がパケットの時刻で代用する)", () => {
    expect(firstFrameTime("")).toBeNaN();
    expect(firstFrameTime("best_effort_timestamp_time=N/A")).toBeNaN();
  });

  test("他の行が混ざっていても読み取れる", () => {
    // ffprobe はデコードできないコマについて警告を吐くことがある
    expect(
      firstFrameTime(`[mpeg2video] Invalid frame dimensions 0x0.\n${output}`),
    ).toBeCloseTo(6116.439489, 6);
  });
});

/**
 * TS の時刻は**放送の時刻そのもの** (PTS) で、先頭からの秒数ではない。実機では
 * 62170 のような値が入る。引き算を忘れるとその値がそのまま先頭捨ての長さになり、
 * 17 時間ぶん読み飛ばして中身の無いものができあがる
 */
describe("先頭から捨てる長さの上限", () => {
  test("入れ物の始まりから数える", () => {
    expect(leadIn(62170.583, 62169.916)).toBeCloseTo(0.667, 3);
  });

  test("数秒を超えるずれは信じない", () => {
    // 引き算を忘れたときの値。そのまま渡すと出来上がりが壊れる
    expect(leadIn(62170.583, 0)).toBe(0);
    expect(leadIn(62170.583, Number.NaN)).toBe(0);
  });

  test("映像のほうが先なら 0", () => {
    expect(leadIn(10, 10.5)).toBe(0);
    expect(leadIn(Number.NaN, 0)).toBe(0);
  });
});

describe("画素の横長さ", () => {
  test("比を数にする", () => {
    expect(parseRatio("4:3")).toBeCloseTo(4 / 3, 6);
    expect(parseRatio("1:1")).toBe(1);
  });

  test("読めなければ 1 (正方形)", () => {
    // ffmpeg は分からないとき 0:1 や N/A を返す。0 を掛けると幅が消える
    expect(parseRatio("0:1")).toBe(1);
    expect(parseRatio("N/A")).toBe(1);
    expect(parseRatio(undefined)).toBe(1);
  });
});

describe("chapterMetadata", () => {
  test("本編と CM が時刻順のチャプターになる", () => {
    const meta = chapterMetadata([{ start: 300, end: 360 }], 600);
    expect(meta.startsWith(";FFMETADATA1")).toBe(true);
    expect(meta).toContain("START=0");
    expect(meta).toContain("END=300000");
    expect(meta).toContain("title=CM");
    expect(meta).toContain("title=本編");
    // 本編 → CM → 本編 の 3 チャプター
    expect(meta.match(/\[CHAPTER\]/g)).toHaveLength(3);
  });
});

describe("チャプターを書き直す", () => {
  test("再エンコードせず、渡したチャプターに差し替える。null なら外す", () => {
    expect(chapterArgs("/a.mkv", "/c.txt", "/o.mkv").join(" ")).toContain(
      "-i /c.txt -map 0 -map_chapters 1 -c copy",
    );
    expect(chapterArgs("/a.mkv", null, "/o.mkv").join(" ")).toContain(
      "-map 0 -map_chapters -1 -c copy",
    );
  });
});

describe("ffprobe の読み取り", () => {
  /**
   * 実機の TOKYO MX の元の TS。MX1 と MX2 が同じ TS に入っているので
   * `-select_streams v:0` を付けても番組の数だけ並ぶ。
   * 並び順も**指定した順ではない** (avg_frame_rate,width,height と指定して幅から来る)
   */
  const MX = [
    "width=1440",
    "height=1080",
    "avg_frame_rate=30000/1001",
    "",
    "width=1440",
    "height=1080",
    "avg_frame_rate=30000/1001",
  ].join("\n");

  test("位置ではなくキーで読む。指定した順では返ってこない", () => {
    /*
     * ここを位置で受けていた頃は 1440 をフレームレートとして採り、
     * 30 分アニメの本編 4 万 2 千コマが 29 秒に潰れて「番組の 98% が CM」になっていた。
     * その前は丸ごと split('/') していて 30000 を採り、1.4 秒 =「100% が CM」。
     * どちらも CM 検出の結果が毎回捨てられて無音検出に落ちていた (録画 34・35・38)
     */
    const stream = fields(MX);
    expect(parseFrameRate(stream.get("avg_frame_rate"))).toBeCloseTo(29.97, 2);
    expect(Number(stream.get("width"))).toBe(1440);
    expect(Number(stream.get("height"))).toBe(1080);
  });

  test("同じキーが並んだら最初のものを採る", () => {
    expect(fields("duration=10\nduration=999").get("duration")).toBe("10");
  });

  test("読めなければ NaN。呼ぶ側が既定に落とす", () => {
    expect(parseFrameRate("N/A")).toBeNaN();
    expect(parseFrameRate("0/0")).toBeNaN();
    expect(parseFrameRate("")).toBeNaN();
    expect(parseFrameRate(undefined)).toBeNaN();
  });

  test("分母のない書き方も読む", () => {
    expect(parseFrameRate("25")).toBe(25);
  });
});

describe("CM 判定が多すぎないか", () => {
  test("番組の半分以上が CM になったら信じない", () => {
    // ロゴを覚えたての回で「先頭の 2 秒だけ本編」になり、30 分アニメが丸ごと CM 扱いになる
    const whole = invertRanges([{ start: 0, end: 2 }], 1802);
    expect(cmRatio(whole, 1802)).toBe(100);
    expect(tooMuchCm(whole, 1802)).toBe(true);

    // まともな結果 (CM 3 か所で 10%) は通す
    const normal = [
      { start: 0, end: 10 },
      { start: 600, end: 660 },
      { start: 1700, end: 1802 },
    ];
    expect(tooMuchCm(normal, 1802)).toBe(false);
    expect(cmRatio(normal, 1802)).toBe(10);
  });

  test("ちょうど半分から捨てる (丸めた % では比べない)", () => {
    expect(tooMuchCm([{ start: 0, end: 900 }], 1800)).toBe(true);
    expect(tooMuchCm([{ start: 0, end: 899 }], 1800)).toBe(false);
  });
});

describe("ロゴの結果を捨てたときの覚え書き", () => {
  /** 100 秒 (30 コマ/秒)。前半はロゴがはっきり見え、続く 25 秒は点が出たとみなすところに届かず、最後の 25 秒は 0 近く */
  function material(logo = true): CmMaterial {
    const frames = 3000;
    return {
      offset: 0,
      duration: 100,
      fps: 30,
      silences: [],
      times: Float64Array.from({ length: frames }, (_, i) => i / 30),
      cuts: new Float32Array(frames),
      logo: logo
        ? {
            spans: [{ start: 0, end: 1499 }],
            scores: Float32Array.from({ length: frames }, (_, i) =>
              i < 1500 ? 0.7 : i < 2250 ? 0.18 : 0.02,
            ),
          }
        : null,
      logoModel: "枠 1290,30,92,67、型 312 画素",
      why: "",
    };
  }

  test("型の在り処、ロゴの写っていた割合、点の分布、CM とした区間と区間の中の点を書く", () => {
    expect(logoDetail(material(), [{ start: 50, end: 100 }])).toBe(
      "。ロゴ: 枠 1290,30,92,67、型 312 画素、写っていたコマ 50%。" +
        "ロゴの点: 0.25 以上 50%、0.12〜0.25 25%、0.12 未満 25%。" +
        "ロゴで CM とした区間: 0:50〜1:40 (点 0.18)",
    );
  });

  test("CM が無ければ区間は書かない。ロゴが使えなければ何も足さない", () => {
    expect(logoDetail(material(), [])).not.toContain("CM とした区間");
    expect(logoDetail(material(false), [{ start: 50, end: 100 }])).toBe("");
  });
});

describe("ロゴで判定できなかったと扱うか", () => {
  test("CM 検出の覚え書きから決める。別の印は持たない", () => {
    /*
     * 実機に残っていた文言。印を別に持っていた頃は、後から条件を広げても
     * 既に録ってある分には効かなかった
     */
    expect(
      logoUnusable(
        "無音 8 箇所 (ロゴは使えず: ロゴ判定が失敗: ロゴの在り処が割り出せませんでした)",
      ),
    ).toBe(true);
    expect(
      logoUnusable(
        "無音 30 箇所 (ロゴは使えず: 番組の 100% がCMという結果だったので捨てました)",
      ),
    ).toBe(true);
    // ロゴで判定できている。ここで出すと、直しようのないものまで対象になる
    expect(logoUnusable("ロゴ")).toBe(false);
    expect(logoUnusable("無音 8 箇所")).toBe(false);
    expect(logoUnusable(null)).toBe(false);
  });
});

/**
 * 録画の尻に次の番組の副音声が入ると、探りの間に中身の来ない音声が 1 本増える。
 * 実機の ffprobe の出力 (programs と streams の両方に同じものが並ぶ) をそのまま使う
 */
describe("中身のある音声だけを選ぶ", () => {
  test("channels が 0 の音声は外す", () => {
    const json =
      '{"programs":[{"streams":[{"channels":2},{"channels":0}]},{"streams":[]}],"streams":[{"channels":2},{"channels":0}]}';
    expect(liveAudioIndexes(json)).toEqual([0]);
  });

  test("多重音声はどちらも選ぶ", () => {
    expect(
      liveAudioIndexes('{"streams":[{"channels":2},{"channels":2}]}'),
    ).toEqual([0, 1]);
  });

  test("音声が無い・channels が出てこないときは空", () => {
    expect(liveAudioIndexes('{"streams":[]}')).toEqual([]);
    expect(liveAudioIndexes("{}")).toEqual([]);
    expect(liveAudioIndexes('{"streams":[{}]}')).toEqual([]);
  });
});

/**
 * 本番の録画 562 (TBS の 30 分、1080i 29.97 コマ/秒) の形を合成したもの。尺は 1791.8 秒なのに、コマは 1130 秒 (18 分 50 秒) で止まり、
 * その前にも 2〜3 秒ずつ欠けた所が散らばる。ロゴは本編で十分に当たっていて、区間は 40-129 151-490 539-775 783-949 1019-1043 秒
 */
describe("途中から映像が欠けた録画", () => {
  const FPS = 29.97;
  const DURATION = 1791.8;
  const END = 1130;
  const HOLES = [
    [440, 442.5],
    [800, 803],
    [960, 962.5],
    [1000, 1002],
    [1120, 1123],
  ] as const;
  const SPANS = [
    [40, 129],
    [151, 490],
    [539, 775],
    [783, 949],
    [1019, 1043],
  ] as const;
  /** CM の継ぎ目 (無音と強い切れ目)。無音は 1116 秒まで */
  const JOINTS = [
    10, 25, 40, 129, 144, 490, 505, 520, 535, 949, 964, 979, 994, 1009, 1043,
    1058, 1073, 1088, 1103,
  ];

  function material(): CmMaterial {
    const times: number[] = [];
    for (let i = 0; i / FPS < END; i++) {
      const t = i / FPS;
      if (HOLES.some(([from, to]) => t > from && t < to)) continue;
      times.push(t);
    }
    const cuts = new Float32Array(times.length);
    const frameAt = (t: number) => {
      const i = times.findIndex((x) => x >= t);
      return i < 0 ? times.length - 1 : i;
    };
    for (const t of JOINTS) cuts[frameAt(t)] = 30;
    const lit = (t: number) => SPANS.some(([from, to]) => t >= from && t < to);
    return {
      offset: 0,
      duration: DURATION,
      fps: FPS,
      programLength: 1800,
      programStart: 10,
      silences: JOINTS.map((t) => ({ start: t - 0.5, end: t + 0.5 })),
      times: Float64Array.from(times),
      cuts,
      logo: {
        spans: SPANS.map(([from, to]) => ({
          start: frameAt(from),
          end: frameAt(to) - 1,
        })),
        scores: Float32Array.from(times, (t) => (lit(t) ? 0.75 : 0.02)),
      },
      why: "",
    };
  }

  test("映像の無い 11 分を CM と数えず、ロゴの結果を使う", () => {
    const found = decideFromMaterial(material());
    expect(found.note).toBe(LOGO_OK);
    expect(found.cm.length).toBeGreaterThan(0);
    // 映像が止まった後ろは CM にしない
    for (const range of found.cm) expect(range.end).toBeLessThanOrEqual(END);
    // 本編 (ロゴの区間) は CM にしない
    for (const range of found.cm)
      for (const [from, to] of SPANS)
        expect(
          Math.min(range.end, to - 8) - Math.max(range.start, from + 8),
        ).toBeLessThanOrEqual(0);
  });

  test("CM の割合は、映像の欠けた所を分母からも分子からも外して数える", () => {
    const missing = [{ start: 1130, end: 1791.8 }];
    const cm = [{ start: 1043, end: 1791.8 }];
    // 欠けた所を入れると 42%、外すと 1043〜1130 の 87 秒 / 1130 秒で 8%
    expect(cmRatio(cm, 1791.8)).toBe(42);
    expect(cmRatio(cm, 1791.8, missing)).toBe(8);
    expect(tooMuchCm([{ start: 0, end: 1000 }], 1791.8)).toBe(true);
    expect(tooMuchCm([{ start: 0, end: 1000 }], 1791.8, missing)).toBe(true);
    expect(tooMuchCm([{ start: 500, end: 1791.8 }], 1791.8, missing)).toBe(
      true,
    );
    expect(tooMuchCm([{ start: 700, end: 1791.8 }], 1791.8, missing)).toBe(
      false,
    );
  });
});
