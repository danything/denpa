import { describe, expect, test } from "bun:test";

import { compileNg, foldText, NG_LENGTH, NG_MAX, parseNg, readNg } from "./ng";

/*
 * NG ワード
 */

describe("compileNg", () => {
  test("部分一致で引っかける", () => {
    const ng = compileNg(["ネタバレ"]);
    expect(ng("これはネタバレだ")).toBe(true);
    expect(ng("ネタ")).toBe(false);
  });

  test("全角・半角、半角カナ、英字の大小、ひらがな・カタカナは同じとみなす", () => {
    const ng = compileNg(["ｗｗｗ", "ﾈﾀﾊﾞﾚ", "ABC"]);
    expect(ng("草www")).toBe(true);
    expect(ng("ねたばれ注意")).toBe(true);
    expect(ng("abc")).toBe(true);
    expect(compileNg(["かわいい"])("カワイイ")).toBe(true);
    expect(compileNg(["ゞ"])("ヾ")).toBe(true);
  });

  test("正規表現としては読まない", () => {
    const ng = compileNg([".*"]);
    expect(ng("なんでも")).toBe(false);
    expect(ng("a.*b")).toBe(true);
  });

  test("語が無ければ何も引っかけない", () => {
    expect(compileNg([])("なんでも")).toBe(false);
    expect(compileNg(["  "])("なんでも")).toBe(false);
  });

  test("長音はそのまま (ひらがなにしても変わらない)", () => {
    expect(foldText("ラーメン")).toBe("らーめん");
  });
});

describe("parseNg", () => {
  test("1 行に 1 語。前後の空白・空の行・同じ語は外す", () => {
    expect(parseNg(" a \n\n  \r\nb\na\n")).toEqual({ words: ["a", "b"] });
  });

  test("多すぎる・長すぎるものは理由を返す", () => {
    const many = Array.from({ length: NG_MAX + 1 }, (_, i) => `w${i}`);
    expect(parseNg(many.join("\n"))).toHaveProperty("error");
    expect(parseNg(many.slice(0, NG_MAX).join("\n"))).toHaveProperty("words");
    expect(parseNg("あ".repeat(NG_LENGTH + 1))).toHaveProperty("error");
    // 絵文字も 1 文字と数える
    expect(parseNg("😀".repeat(NG_LENGTH))).toHaveProperty("words");
  });
});

describe("readNg", () => {
  test("保存した JSON の配列を読む。壊れていれば空", () => {
    expect(readNg('["a","b"]')).toEqual(["a", "b"]);
    expect(readNg(undefined)).toEqual([]);
    expect(readNg("{")).toEqual([]);
    expect(readNg('{"a":1}')).toEqual([]);
    expect(readNg('["a",1," ",null]')).toEqual(["a"]);
  });
});
