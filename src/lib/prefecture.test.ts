import { describe, expect, test } from "bun:test";
import {
  normalizePrefecture,
  PREFECTURE_UNSET,
  PREFECTURES,
  parsePrefectureField,
} from "./prefecture";

/*
 * **都道府県の番号は ARIB の県域 (STD-B10 付録G 表G-2)。** JIS の都道府県コードではないので、
 * 東京都は 13 ではなく 14。放送はこの値を `nvram://receiverinfo/prefecture` で読む。
 */
describe("都道府県", () => {
  test("1〜50 がちょうど1つずつある", () => {
    const codes = PREFECTURES.map((p) => p.code).sort((a, b) => a - b);
    expect(codes).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  test("JIS の番号とずれる所 (北海道が東西、島部が別)", () => {
    const name = (code: number) =>
      PREFECTURES.find((p) => p.code === code)?.name;
    expect(name(14)).toBe("東京都");
    expect(name(48)).toBe("沖縄県");
    expect(name(49)).toBe("東京都 (伊豆・小笠原諸島)");
    expect(name(50)).toBe("鹿児島県 (南西諸島)");
  });

  test("島部は本土のすぐ後に並べる", () => {
    const at = (code: number) => PREFECTURES.findIndex((p) => p.code === code);
    expect(at(49)).toBe(at(14) + 1);
    expect(at(50)).toBe(at(47) + 1);
  });

  test("表にある番号はそのまま (文字でも数でも)", () => {
    expect(normalizePrefecture("14")).toBe(14);
    expect(normalizePrefecture(" 50 ")).toBe(50);
    expect(normalizePrefecture(1)).toBe(1);
  });

  test("無い・表に無い番号は未設定 (255)", () => {
    expect(normalizePrefecture(undefined)).toBe(PREFECTURE_UNSET);
    expect(normalizePrefecture("")).toBe(PREFECTURE_UNSET);
    expect(normalizePrefecture("255")).toBe(PREFECTURE_UNSET);
    expect(normalizePrefecture("0")).toBe(PREFECTURE_UNSET);
    expect(normalizePrefecture("51")).toBe(PREFECTURE_UNSET);
    expect(normalizePrefecture("1.5")).toBe(PREFECTURE_UNSET);
    expect(normalizePrefecture("-1")).toBe(PREFECTURE_UNSET);
    expect(normalizePrefecture("とうきょう")).toBe(PREFECTURE_UNSET);
  });
});

/*
 * **設定画面の欄は、表の番号か 255 だけを受ける。** ほかは断る (画面の外から来たもの)。
 */
describe("設定画面の欄", () => {
  test("表の番号と未設定 (255) は受ける。欄が無ければ未設定", () => {
    expect(parsePrefectureField("14")).toBe(14);
    expect(parsePrefectureField("255")).toBe(255);
    expect(parsePrefectureField(null)).toBe(255);
  });

  test("表に無い番号・書き方の違うものは断る", () => {
    expect(parsePrefectureField("51")).toBeNull();
    expect(parsePrefectureField("0")).toBeNull();
    expect(parsePrefectureField("014")).toBeNull();
    expect(parsePrefectureField("")).toBeNull();
    expect(parsePrefectureField("tokyo")).toBeNull();
  });
});
