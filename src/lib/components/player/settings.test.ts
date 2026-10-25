import { describe, expect, test } from "bun:test";

import { captionLanguage } from "@doany/arib/caption-text";

import { subtitles } from "./settings";

const JPN = captionLanguage(1, "jpn");
const ENG = captionLanguage(2, "eng");
const icon = (() => null) as never;

function choice(over: Partial<Parameters<typeof subtitles>[0]> = {}) {
  const calls: string[] = [];
  const made = subtitles({
    icon,
    on: true,
    languages: [JPN, ENG],
    language: 1,
    onoff: (on) => calls.push(on ? "on" : "off"),
    ontrack: (index) => calls.push(`track ${index}`),
    onlanguage: (index) => calls.push(`language ${index}`),
    ...over,
  });
  return { made, calls };
}

describe("⚙ の字幕の行", () => {
  test("オフと言語を並べ、いまの言語を値に出す", () => {
    const { made } = choice();
    expect(made.options.map((o) => o.label)).toEqual([
      "オフ",
      "日本語",
      "英語",
    ]);
    expect(made.value).toBe("日本語");
    expect(made.options.find((o) => o.active)?.label).toBe("日本語");
  });

  test("消していればオフが選ばれている", () => {
    const { made } = choice({ on: false });
    expect(made.value).toBe("オフ");
    expect(made.options.filter((o) => o.active).map((o) => o.key)).toEqual([
      "off",
    ]);
  });

  test("言語を選ぶと出して、言語だけを替える", () => {
    const { made, calls } = choice({ on: false });
    made.pick("0:2");
    expect(calls).toEqual(["on", "language 2"]);
  });

  test("オフを選ぶと消すだけ", () => {
    const { made, calls } = choice();
    made.pick("off");
    expect(calls).toEqual(["off"]);
  });

  test("言語が1つなら、オフとオンだけ (名前が分かればその名前)", () => {
    expect(
      choice({ languages: [JPN] }).made.options.map((o) => o.label),
    ).toEqual(["オフ", "日本語"]);
    expect(choice({ languages: [] }).made.options.map((o) => o.label)).toEqual([
      "オフ",
      "オン",
    ]);
  });

  test("字幕のストリームが複数なら、いまのストリームだけ言語に開く。別のストリームは再エンコード", () => {
    const tracks = [
      { index: 0, label: "字幕 (日本語)" },
      { index: 1, label: "字幕 (英語)" },
    ];
    const { made, calls } = choice({ tracks, track: 0 });
    expect(made.options.map((o) => o.label)).toEqual([
      "オフ",
      "字幕 (日本語) 日本語",
      "字幕 (日本語) 英語",
      "字幕 (英語)",
    ]);
    made.pick("1:0");
    expect(calls).toEqual(["on", "track 1"]);
  });
});
