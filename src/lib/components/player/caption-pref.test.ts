import { describe, expect, test } from "bun:test";

import { captionLanguage } from "@doany/arib/caption-text";

import { pickLanguage, storedCaptionsOn } from "./caption-pref";

const JPN = captionLanguage(1, "jpn");
const ENG = captionLanguage(2, "eng");

describe("字幕の覚え方", () => {
  test("出し入れは、消したことのある端末だけ消して始まる", () => {
    expect(storedCaptionsOn(null)).toBe(true);
    expect(storedCaptionsOn("1")).toBe(true);
    expect(storedCaptionsOn("0")).toBe(false);
  });

  test("覚えている言語が載っていれば、その番号を選ぶ", () => {
    expect(pickLanguage([JPN, ENG], "eng")).toBe(2);
    expect(pickLanguage([JPN, ENG], "jpn")).toBe(1);
  });

  test("載っていなければ第1言語", () => {
    expect(pickLanguage([JPN, ENG], "kor")).toBe(1);
    expect(pickLanguage([JPN, ENG], null)).toBe(1);
    expect(pickLanguage([], "eng")).toBe(1);
  });

  test("英語が第1言語の番組でも、言葉で選ぶ", () => {
    expect(
      pickLanguage(
        [captionLanguage(1, "eng"), captionLanguage(2, "jpn")],
        "jpn",
      ),
    ).toBe(2);
  });
});
