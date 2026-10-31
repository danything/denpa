import { describe, expect, test } from "bun:test";

import {
  captionWords,
  clipParams,
  commentSpots,
  frameRoom,
  shotName,
} from "./snapshot";

describe("切り抜きのファイル名", () => {
  const at = new Date(2026, 9, 2, 9, 5, 7);

  test("番組名_YYYYMMDD-HHMMSS.png", () => {
    expect(shotName("ニュース7", at)).toBe("ニュース7_20261002-090507.png");
  });

  test("ファイル名に使えない半角の字は _ に替える。全角はそのまま", () => {
    expect(shotName('劇場版 A/B: 第1話 "前編" ／後編?', at)).toBe(
      "劇場版 A_B_ 第1話 _前編_ ／後編__20261002-090507.png",
    );
  });

  test("空白は1つに詰め、末尾の点と空白は落とす", () => {
    expect(shotName("  遠い  星の…  ", at)).toBe(
      "遠い 星の…_20261002-090507.png",
    );
    expect(shotName("おわり...", at)).toBe("おわり_20261002-090507.png");
  });

  test("長い名前は 60 字で切る", () => {
    const name = shotName("あ".repeat(200), at);
    expect(name).toBe(`${"あ".repeat(60)}_20261002-090507.png`);
  });

  test("名前が残らなければ denpa", () => {
    expect(shotName("", at)).toBe("denpa_20261002-090507.png");
    expect(shotName(" . ", at)).toBe("denpa_20261002-090507.png");
  });
});

describe("切り抜きに添える字幕の文字", () => {
  const run = (x: number, y: number, text: string, extra = {}) => ({
    x,
    y,
    w: 36,
    h: 36,
    fx: 0,
    fy: 0,
    size: 36,
    scaleX: 1,
    text,
    fg: "#ffffffff",
    bg: "#00000000",
    ...extra,
  });

  test("上の行から、行の中は左から。ルビと外字は落とす", () => {
    const page = {
      v: 1 as const,
      plane: [960, 540] as [number, number],
      duration: null,
      runs: [
        run(300, 480, "ニュースです"),
        run(100, 480, "７時の"),
        run(100, 420, "こんばんは"),
        run(100, 400, "ばん", { ruby: true }),
        run(500, 420, "〓", { drcs: "a" }),
      ],
    };
    expect(captionWords(page)).toBe("こんばんは ７時のニュースです");
    expect(captionWords(null)).toBe("");
  });
});

describe("切り抜きを送る URL", () => {
  test("録画は ID と位置 (観ているものの物差し)", () => {
    expect(
      String(
        clipParams(
          { place: "watch", recording: 12, at: 61.23456, source: "encoded" },
          "字幕",
        ),
      ),
    ).toBe(
      "place=watch&recording=12&at=61.235&source=encoded&captions=%E5%AD%97%E5%B9%95",
    );
  });

  test("ライブは局と放送時刻。字幕が無ければ付けない", () => {
    expect(
      String(clipParams({ place: "live", service: 7, aired: 1000.4 }, "")),
    ).toBe("place=live&service=7&aired=1000");
    expect(
      String(clipParams({ place: "live", service: 7, aired: null }, "")),
    ).toBe("place=live&service=7");
  });
});

describe("切り抜きに写すコメントの位置", () => {
  // 映像の枠は画面の (100, 50) から 640x360
  const frame = { left: 100, top: 50, width: 640, height: 360 };
  const comment = (left: number, top: number, width = 120, height = 24) => ({
    text: "草",
    font: "normal 400 20px sans-serif",
    color: "rgb(255, 255, 255)",
    box: { left, top, width, height },
  });

  test("枠の左上からの位置にする。縦は行の中ほど", () => {
    expect(commentSpots(frame, [comment(300, 74)])).toEqual([
      {
        text: "草",
        font: "normal 400 20px sans-serif",
        color: "rgb(255, 255, 255)",
        x: 200,
        y: 36,
      },
    ]);
  });

  test("流れ込んでいる途中・出ていく途中は描く (はみ出したぶんは枠で切れる)", () => {
    const spots = commentSpots(frame, [comment(700, 60), comment(30, 60)]);
    expect(spots.map((spot) => spot.x)).toEqual([600, -70]);
  });

  test("枠の外のもの (まだ入っていない・流れ去った) と幅の無いものは描かない", () => {
    expect(
      commentSpots(frame, [
        comment(740, 60),
        comment(-20, 60),
        comment(300, 410),
        comment(300, 60, 0),
      ]),
    ).toEqual([]);
  });
});

describe("重ねと一緒に送るときの映像の大きさ", () => {
  test("本文の上限から区切りのぶんと重ねを引いた残り", () => {
    expect(frameRoom([100_000, 50_000])).toBe(512 * 1024 - 4 * 1024 - 150_000);
  });

  test("重ねが無い・残りが狭すぎれば null (重ねたものを1枚で送る)", () => {
    expect(frameRoom([])).toBeNull();
    expect(frameRoom([460 * 1024])).toBeNull();
  });
});
