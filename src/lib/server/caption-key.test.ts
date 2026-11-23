import { describe, expect, test } from "bun:test";

import {
  captionGrams,
  captionHits,
  captionKey,
  captionMatch,
  captionTerms,
} from "./caption-key";

describe("字幕で探すための揃え方", () => {
  test("空白 (全角も) を消し、全角の英数を半角・小文字にする", () => {
    expect(captionKey("東京都の　天気は ＡＢＣ").key).toBe("東京都の天気はabc");
  });

  test("外字は昔の書き方に開き、元の文字の位置を覚える", () => {
    const { key, from, to } = captionKey("🈟番組");
    expect(key).toBe("[新]番組");
    // 「[新]」の 3 字はどれも元の 1 字 (UTF-16 で 2 単位) から
    expect(from.slice(0, 3)).toEqual([0, 0, 0]);
    expect(to.slice(0, 3)).toEqual([2, 2, 2]);
    expect(from[3]).toBe(2);
  });

  test("2 字ずつ重ねて区切る。1 字ならその字", () => {
    expect(captionGrams("東京都")).toBe("東京 京都");
    expect(captionGrams("雨")).toBe("雨");
    expect(captionGrams("")).toBe("");
    // 外字 (サロゲートペア) も 1 字
    expect(captionGrams("𠮷野家")).toBe("𠮷野 野家");
  });

  test("2 字以上の語をフレーズにして AND でつなぐ。1 字の語は入れない", () => {
    expect(captionMatch(captionTerms(["東京都", "雨"]))).toBe('"東京 京都"');
    expect(captionMatch(captionTerms(["地震", "津波"]))).toBe(
      '"地震" AND "津波"',
    );
  });

  test("2 字以上の続きが無い語だけなら式を作らない (空の式にしない)", () => {
    expect(captionMatch(captionTerms(["雨"]))).toBeNull();
    expect(captionMatch(captionTerms(["　"]))).toBeNull();
    expect(captionMatch([])).toBeNull();
  });

  test("記号だけの語も区切れる", () => {
    expect(captionMatch(captionTerms(["(笑)"]))).toBe('"(笑 笑)"');
    expect(captionMatch(captionTerms(["♪♪"]))).toBe('"♪♪"');
    expect(captionMatch(captionTerms(["a・b"]))).toBe('"a・ ・b"');
    expect(captionMatch(captionTerms(['"a"']))).toBe('"""a a"""');
  });

  test("語をすべて含めば、当たった所を元の文字の位置で返す", () => {
    const keys = captionTerms(["東京都の天気", "雨"]);
    // 行の間の空白をまたいでも当たる
    expect(captionHits("東京都の 天気は雨です", keys)).toEqual([
      [0, 7],
      [8, 9],
    ]);
    expect(captionHits("東京都の天気は晴れ", keys)).toBeNull();
  });

  test("サロゲートペアの字を含む語も、元の文字の位置で返す", () => {
    // 𠮷 は UTF-16 で 2 単位
    expect(captionHits("𠮷野家の 牛丼", captionTerms(["𠮷野家の牛"]))).toEqual([
      [0, 7],
    ]);
    expect(captionHits("あ𠮷野家", captionTerms(["野家"]))).toEqual([[3, 5]]);
  });

  test("重なった当たりはまとめる", () => {
    expect(captionHits("ああああ", captionTerms(["ああ", "あああ"]))).toEqual([
      [0, 4],
    ]);
  });
});
